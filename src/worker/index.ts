import { Hono, type Context } from 'hono';
import auth, { ApiError, assertWritable, jsonBody, requireAuth, sameOrigin, sha256 } from './auth';
import backup from './backup';
import sharing, { createShare } from './share';
import { serveFile, type FileRow } from './files';
import type { AppEnv, Bindings } from './types';

const app = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;
type Row = Record<string, any>;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_NOTE = 100_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(message: string): never { throw new ApiError(400, 'INVALID_ARGUMENT', message); }
function idOf(value: unknown): string { if (typeof value !== 'string' || !uuid.test(value)) invalid('无效的记录编号。'); return value; }
function writeGuard(c: Ctx) {
  // Fence sessions again at commit: an in-flight request cannot overwrite a restored database.
  return c.env.DB.prepare('UPDATE app_state SET maintenance=CASE WHEN maintenance=0 AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?) THEN 0 ELSE NULL END WHERE id=1').bind(c.get('sessionHash'),Date.now());
}
function onlyQuery(c: Ctx, allowed: string[]) { for (const key of new URL(c.req.url).searchParams.keys()) if (!allowed.includes(key)) invalid(`不支持的查询条件：${key}`); }
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) invalid('数字或日期范围无效。'); return n;
}
function contentOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > MAX_NOTE) invalid('笔记不能为空，且不能超过 100 KB。');
  return value;
}
// Personal tag syntax: #tag in prose, outside fenced/inline code. No CEL or regex filters.
function tagsOf(content: string): string[] {
  const prose = content.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/`+[^`\n]*`+/g, '');
  return [...new Set([...prose.matchAll(/(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_\-/]{0,63})/gu)].map(m => m[1]))].slice(0, 100);
}
function attachmentShape(a: Row) { return { id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: `/files/${a.id}` }; }
async function notesShape(c: Ctx, rows: Row[]) {
  if (!rows.length) return [];
  const linked = await c.env.DB.prepare('SELECT na.note_id,a.* FROM note_attachments na JOIN attachments a ON a.id=na.attachment_id WHERE a.status=\'ready\' AND na.note_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(rows.map(r => r.id))).all<Row>();
  return rows.map(n => ({ id: n.id, content: n.content, tags: JSON.parse(n.tags_json), createdAt: n.created_at, updatedAt: n.updated_at, archived: n.archived_at !== null, pinned: !!n.pinned, version: n.version, attachments: linked.results.filter(a => a.note_id === n.id).map(attachmentShape) }));
}
async function getNote(c: Ctx, id: string) {
  const row = await c.env.DB.prepare('SELECT * FROM notes WHERE id=?').bind(id).first<Row>();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '笔记不存在。');
  return (await notesShape(c, [row]))[0];
}
async function attachmentIds(c: Ctx, value: unknown, content: string): Promise<string[]> {
  if (value !== undefined && (!Array.isArray(value) || value.length > 40)) invalid('附件列表无效或超过 40 个。');
  const inline = [...content.matchAll(/\/files\/([0-9a-f-]{36})(?=[\s)\]"'?]|$)/gi)].map(m => idOf(m[1]));
  const ids = [...new Set([...(value as unknown[] ?? []).map(idOf), ...inline])];
  if (ids.length > 40) invalid('每篇笔记最多关联 40 个附件。');
  const found = await c.env.DB.prepare("SELECT count(*) AS n FROM attachments WHERE status='ready' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).first<{ n: number }>();
  if (found?.n !== ids.length) invalid('附件尚未上传完成或已删除，请重新上传。');
  return ids;
}

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return c.json({ error: { code: 'HTTPS_REQUIRED', message: '必须使用 HTTPS。' } }, 400);
  c.header('X-Content-Type-Options', 'nosniff'); c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY'); c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (url.protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) { c.header('Cache-Control', 'no-store'); sameOrigin(c); }
  await next();
});
app.onError((err, c) => {
  let status = err instanceof ApiError ? err.status : 500;
  let code = err instanceof ApiError ? err.code : 'INTERNAL_ERROR';
  let message = err instanceof ApiError ? err.message : '操作未完成，请稍后重试；未保存的草稿会保留。';
  if (/maintenance/.test(err.message)) { status = 503; code = 'MAINTENANCE'; message = '正在备份或恢复，暂时不能修改数据。'; }
  else if (/NOT NULL constraint failed: notes.version/.test(err.message)) { status = 409; code = 'VERSION_CONFLICT'; message = '笔记已在其他页面修改，请保留草稿并重新加载。'; }
  else if (/attachment_unavailable|NOT NULL constraint failed: app_state.maintenance/.test(err.message)) { status = 409; code = 'STATE_CHANGED'; message = '会话、附件或维护状态已变化，请重新加载后重试；草稿不会丢失。'; }
  if (status === 500) console.error('qingji request failed', err.name, err.message);
  return c.json({ error: { code, message } }, status as any);
});
app.route('/api/auth', auth);
app.route('/s', sharing);
app.use('/api/*', requireAuth);
app.use('/files/*', requireAuth);
app.route('/api/backup', backup);
app.post('/api/notes/:id/share', createShare);

app.get('/api/notes', async c => {
  onlyQuery(c, ['q', 'tag', 'from', 'to', 'archived', 'limit', 'offset']);
  const q = c.req.query('q') ?? '', tag = c.req.query('tag') ?? '';
  if (q.length > 500 || tag.length > 64) invalid('搜索词或标签过长。');
  const archive = c.req.query('archived') ?? '0'; if (!['0', '1'].includes(archive)) invalid('归档条件无效。');
  const from = integer(c.req.query('from'), 0, 0, 8_640_000_000_000_000);
  const to = integer(c.req.query('to'), 8_640_000_000_000_000, 0, 8_640_000_000_000_000); if (to < from) invalid('结束日期早于开始日期。');
  const limit = integer(c.req.query('limit'), 30, 1, 100), offset = integer(c.req.query('offset'), 0, 0, 1_000_000);
  const where = `archived_at IS ${archive === '1' ? 'NOT ' : ''}NULL AND created_at>=? AND created_at<? AND instr(lower(content),lower(?))>0 AND (?='' OR EXISTS(SELECT 1 FROM json_each(notes.tags_json) WHERE value=?))`;
  const args = [from, to, q, tag, tag];
  const [rows, count] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM notes WHERE ${where} ORDER BY pinned DESC,created_at DESC,id DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset),
    c.env.DB.prepare(`SELECT count(*) AS n FROM notes WHERE ${where}`).bind(...args)
  ]);
  return c.json({ notes: await notesShape(c, rows.results as Row[]), total: (count.results[0] as Row).n });
});
app.get('/api/notes/:id', async c => c.json({ note: await getNote(c, idOf(c.req.param('id'))) }));
app.post('/api/notes', async c => {
  await assertWritable(c); const b = await jsonBody(c, ['id', 'content', 'attachmentIds'], MAX_NOTE + 10000);
  const content = contentOf(b.content), id = b.id === undefined ? crypto.randomUUID() : idOf(b.id);
  const ids = await attachmentIds(c, b.attachmentIds, content);
  const existing = await c.env.DB.prepare('SELECT * FROM notes WHERE id=?').bind(id).first<Row>();
  if (existing) {
    if (existing.content !== content) throw new ApiError(409, 'ID_CONFLICT', '这次保存的编号已使用，请先确认原笔记是否保存成功。');
    const links=(await c.env.DB.prepare('SELECT attachment_id FROM note_attachments WHERE note_id=?').bind(id).all<Row>()).results.map(r=>r.attachment_id).sort();
    if(JSON.stringify(links)!==JSON.stringify([...ids].sort())) throw new ApiError(409,'ID_CONFLICT','重复请求的附件列表不同。');
    return c.json({ note: await getNote(c, id) });
  }
  const now = Date.now();
  await c.env.DB.batch([
    writeGuard(c),
    c.env.DB.prepare('INSERT INTO notes(id,content,tags_json,created_at,updated_at,pinned,version) VALUES(?,?,?,?,?,0,1)').bind(id, content, JSON.stringify(tagsOf(content)), now, now),
    c.env.DB.prepare('INSERT INTO note_attachments(note_id,attachment_id) SELECT ?,value FROM json_each(?)').bind(id, JSON.stringify(ids))
  ]);
  return c.json({ note: await getNote(c, id) }, 201);
});
app.patch('/api/notes/:id', async c => {
  await assertWritable(c); const id = idOf(c.req.param('id')), b = await jsonBody(c, ['version', 'content', 'attachmentIds', 'archived', 'pinned'], MAX_NOTE + 10000);
  if (!Number.isSafeInteger(b.version) || (b.version as number) < 1) invalid('编辑需要笔记版本。');
  const old = await c.env.DB.prepare('SELECT * FROM notes WHERE id=?').bind(id).first<Row>();
  if (!old) throw new ApiError(404, 'NOT_FOUND', '笔记不存在。');
  if (old.version !== b.version) throw new ApiError(409, 'VERSION_CONFLICT', '笔记已在其他页面修改，请保留草稿并重新加载。');
  if (b.archived !== undefined && typeof b.archived !== 'boolean' || b.pinned !== undefined && typeof b.pinned !== 'boolean') invalid('归档与置顶必须是布尔值。');
  const content = b.content === undefined ? old.content : contentOf(b.content);
  let ids: string[] | undefined;
  if (b.attachmentIds !== undefined || b.content !== undefined) {
    const current = b.attachmentIds ?? (await c.env.DB.prepare('SELECT attachment_id FROM note_attachments WHERE note_id=?').bind(id).all<Row>()).results.map(a => a.attachment_id);
    ids = await attachmentIds(c, current, content);
  }
  const statements = [writeGuard(c),c.env.DB.prepare('UPDATE notes SET version=CASE WHEN version=? THEN version+1 ELSE NULL END,content=?,tags_json=?,updated_at=?,archived_at=?,pinned=? WHERE id=?').bind(b.version, content, JSON.stringify(tagsOf(content)), Date.now(), b.archived === undefined ? old.archived_at : b.archived ? Date.now() : null, b.pinned === undefined ? old.pinned : Number(b.pinned), id)];
  if (ids) statements.push(c.env.DB.prepare('DELETE FROM note_attachments WHERE note_id=?').bind(id), c.env.DB.prepare('INSERT INTO note_attachments(note_id,attachment_id) SELECT ?,value FROM json_each(?)').bind(id, JSON.stringify(ids)));
  const result = await c.env.DB.batch(statements);
  if (!result[1].meta.changes) throw new ApiError(404, 'NOT_FOUND', '笔记不存在。');
  return c.json({ note: await getNote(c, id) });
});
app.delete('/api/notes/:id', async c => {
  await assertWritable(c); onlyQuery(c, ['version']); const id = idOf(c.req.param('id'));
  const version = integer(c.req.query('version'), 0, 1, Number.MAX_SAFE_INTEGER); if (!version) invalid('删除需要版本。');
  const current = await c.env.DB.prepare('SELECT version FROM notes WHERE id=?').bind(id).first<{version:number}>();
  if (!current) return c.body(null, 204);
  if (current.version !== version) throw new ApiError(409, 'VERSION_CONFLICT', '笔记已变化，请重新加载后删除。');
  const results = await c.env.DB.batch([
    writeGuard(c),
    c.env.DB.prepare('UPDATE notes SET version=CASE WHEN version=? THEN version+1 ELSE NULL END WHERE id=?').bind(version, id),
    c.env.DB.prepare('DELETE FROM notes WHERE id=? AND version=?').bind(id, version + 1)
  ]);
  if (!results[2].meta.changes) throw new ApiError(409, 'VERSION_CONFLICT', '删除未完成，请重试。');
  // File objects remain until explicit unreferenced deletion, protecting other notes and drafts.
  return c.body(null, 204);
});
app.get('/api/tags', async c => {
  onlyQuery(c, []);
  const result = await c.env.DB.prepare('SELECT j.value AS name,count(*) AS count FROM notes,json_each(notes.tags_json) j WHERE archived_at IS NULL GROUP BY j.value ORDER BY count DESC,name LIMIT 1000').all();
  return c.json({ tags: result.results });
});
app.get('/api/stats', async c => {
  onlyQuery(c, ['from', 'to', 'tzOffset']);
  const from = integer(c.req.query('from'), 0, 0, 8_640_000_000_000_000), to = integer(c.req.query('to'), 8_640_000_000_000_000, 0, 8_640_000_000_000_000);
  const offset = integer(c.req.query('tzOffset'), 0, -840, 840); if (to < from) invalid('日期范围无效。');
  const [days, total] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT strftime('%Y-%m-%d',created_at/1000+?,'unixepoch') AS day,count(*) AS count FROM notes WHERE archived_at IS NULL AND created_at>=? AND created_at<? GROUP BY day ORDER BY day").bind(offset * 60, from, to),
    c.env.DB.prepare('SELECT count(*) AS total,coalesce(sum(archived_at IS NULL),0) AS active,coalesce(sum(archived_at IS NOT NULL),0) AS archived FROM notes')
  ]);
  return c.json({ days: days.results, ...(total.results[0] as Row) });
});

async function readBytes(c: Ctx) {
  if (Number(c.req.header('Content-Length')) > MAX_FILE) throw new ApiError(413, 'FILE_TOO_LARGE', '文件不能超过 10 MiB。');
  const reader = c.req.raw.body?.getReader(); if (!reader) invalid('文件内容为空。');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const {value,done} = await reader.read(); if (done) break; size += value.length; if (size > MAX_FILE) { await reader.cancel(); throw new ApiError(413, 'FILE_TOO_LARGE', '文件不能超过 10 MiB。'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; } return bytes;
}
app.post('/api/attachments', async c => {
  await assertWritable(c); const id = idOf(c.req.header('X-Upload-Id'));
  let filename: string; try { filename = decodeURIComponent(c.req.header('X-Filename') ?? ''); } catch { return invalid('文件名无效。'); }
  if (!filename.trim() || filename.length > 240 || /[\x00-\x1f\x7f/\\]/.test(filename)) invalid('文件名为空、过长或包含路径。');
  const mime = (c.req.header('Content-Type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) || mime.length > 100) invalid('文件类型无效。');
  const bytes = await readBytes(c), digest = await sha256(bytes), key = `files/${id}/${digest}`;
  let row = await c.env.DB.prepare('SELECT * FROM attachments WHERE id=?').bind(id).first<Row>();
  if (row && (row.sha256 !== digest || row.filename !== filename || row.mime !== mime)) throw new ApiError(409, 'UPLOAD_CONFLICT', '重复上传编号对应不同文件，请重新选择文件。');
  if (row?.status === 'deleting') throw new ApiError(409, 'UPLOAD_DELETING', '文件正在删除，请重新选择文件。');
  if (row?.status === 'ready') return c.json({ attachment: attachmentShape(row) });
  if (!row) {
    await c.env.DB.batch([writeGuard(c),c.env.DB.prepare("INSERT OR IGNORE INTO attachments(id,object_key,filename,mime,size,sha256,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)").bind(id, key, filename, mime, bytes.length, digest, Date.now())]);
    row = await c.env.DB.prepare('SELECT * FROM attachments WHERE id=?').bind(id).first<Row>();
    if (!row || row.sha256 !== digest || row.filename !== filename || row.mime !== mime) throw new ApiError(409, 'UPLOAD_CONFLICT', '上传编号冲突，请重新选择文件。');
  }
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: mime }, sha256: digest });
  await c.env.DB.batch([writeGuard(c),c.env.DB.prepare("UPDATE attachments SET status='ready' WHERE id=? AND status='pending' AND sha256=? AND object_key=?").bind(id,digest,key)]);
  const complete=await c.env.DB.prepare("SELECT * FROM attachments WHERE id=? AND status='ready'").bind(id).first<Row>();
  if(!complete || complete.sha256!==digest || complete.object_key!==key) throw new ApiError(409,'UPLOAD_INTERRUPTED','上传状态已变化，请重试。');
  return c.json({ attachment: attachmentShape(complete) }, 201);
});
app.get('/api/attachments', async c => {
  onlyQuery(c,['unreferenced']); if (c.req.query('unreferenced') !== '1') invalid('只支持查询未引用的附件。');
  const rows = await c.env.DB.prepare("SELECT * FROM attachments WHERE status='ready' AND NOT EXISTS(SELECT 1 FROM note_attachments WHERE attachment_id=attachments.id) ORDER BY created_at DESC LIMIT 200").all<Row>();
  return c.json({ attachments: rows.results.map(attachmentShape) });
});
app.delete('/api/attachments/:id', async c => {
  await assertWritable(c); const id = idOf(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT * FROM attachments WHERE id=?').bind(id).first<Row>();
  if (!row) return c.body(null, 204);
  if(row.status==='pending') throw new ApiError(409,'UPLOAD_IN_PROGRESS','文件尚在上传，暂时不能删除。');
  const change = await c.env.DB.batch([writeGuard(c),c.env.DB.prepare("UPDATE attachments SET status='deleting' WHERE id=? AND NOT EXISTS(SELECT 1 FROM note_attachments WHERE attachment_id=?)").bind(id,id)]);
  if (!change[1].meta.changes) throw new ApiError(409, 'FILE_IN_USE', '附件仍被笔记引用，不能删除。');
  await c.env.FILES.delete(row.object_key);
  await c.env.DB.prepare("DELETE FROM attachments WHERE id=? AND status='deleting' AND object_key=?").bind(id,row.object_key).run();
  return c.body(null,204);
});
app.on(['GET','HEAD'], '/files/:id', async c => {
  const id = idOf(c.req.param('id'));
  const row = await c.env.DB.prepare("SELECT * FROM attachments WHERE id=? AND status='ready'").bind(id).first<FileRow>();
  if (!row) throw new ApiError(404,'NOT_FOUND','附件不存在。');
  return serveFile(c, row);
});
app.get('/api/settings', async c => {
  const owner = await c.env.DB.prepare('SELECT display_name,settings_json FROM owner WHERE id=1').first<Row>();
  return c.json({ settings: {theme:'system',...JSON.parse(owner!.settings_json),displayName:owner!.display_name} });
});
app.patch('/api/settings', async c => {
  await assertWritable(c); const b = await jsonBody(c,['displayName','theme']);
  if (b.displayName !== undefined && (typeof b.displayName !== 'string' || !b.displayName.trim() || b.displayName.length>80)) invalid('昵称须为 1–80 个字符。');
  if (b.theme !== undefined && (typeof b.theme!=='string'||!['system','light','dark'].includes(b.theme))) invalid('主题选项无效。');
  await c.env.DB.batch([writeGuard(c),c.env.DB.prepare("UPDATE owner SET display_name=coalesce(?,display_name),settings_json=CASE WHEN ? IS NULL THEN settings_json ELSE json_set(settings_json,'$.theme',?) END,updated_at=? WHERE id=1").bind(b.displayName===undefined?null:(b.displayName as string).trim(),b.theme??null,b.theme??null,Date.now())]);
  const owner = await c.env.DB.prepare('SELECT display_name,settings_json FROM owner WHERE id=1').first<Row>();
  return c.json({settings:{theme:'system',...JSON.parse(owner!.settings_json),displayName:owner!.display_name}});
});
app.all('/api/*', c => c.json({error:{code:'NOT_FOUND',message:'不支持此接口。'}},404));
app.all('/files/*', c => c.json({error:{code:'NOT_FOUND',message:'附件地址无效。'}},404));
app.get('*', c => c.env.ASSETS.fetch(c.req.raw));

export async function cleanup(env: Bindings) {
  const state = await env.DB.prepare('SELECT maintenance FROM app_state WHERE id=1').first<{maintenance:number}>();
  if (state?.maintenance) return;
  // Durable deletion intent first; backup cannot start with pending/deleting rows.
  await env.DB.prepare("UPDATE attachments SET status='deleting' WHERE status='pending' AND created_at<?").bind(Date.now()-24*3600_000).run();
  const rows = await env.DB.prepare("SELECT id,object_key FROM attachments WHERE status='deleting' LIMIT 15").all<Row>();
  for (const row of rows.results) { await env.FILES.delete(row.object_key); await env.DB.prepare("DELETE FROM attachments WHERE id=? AND status='deleting'").bind(row.id).run(); }
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()), env.DB.prepare('DELETE FROM auth_limits WHERE reset_at<?').bind(Date.now()-86400_000)]);
}
export default {fetch:app.fetch, scheduled:async (_event:ScheduledController,env:Bindings)=>{await cleanup(env);}};
