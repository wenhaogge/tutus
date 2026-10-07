import { Hono } from 'hono';
import type { AppEnv } from './types';

// These limits bound a single consistent snapshot and an atomic D1 restore.
const MAX_METADATA = 8 * 1024 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
type Row = Record<string, unknown>;
type Snapshot = {
  manifest: { format: 'qingji-backup'; version: 1; createdAt: number; credentials: 'preserve-target' };
  tables: { owner: Row[]; notes: Row[]; attachments: Row[]; note_attachments: Row[] };
};
class BackupError extends Error {
  constructor(public status: 400 | 409 | 413 | 500 | 503, message: string) { super(message); }
}
function fail(message: string): never { throw new BackupError(400, message); }
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const plain = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(row: Row, names: string[]) {
  if (Object.keys(row).some(key => !names.includes(key))) fail('备份包含未知字段');
}
function parseArray(value: unknown, label: string, maximum: number): Row[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(row => !plain(row))) fail(`${label} 格式错误或超过恢复容量`);
  return value as Row[];
}
/** Pure validator, also exercised by local tests before any restore mutation. */
export function validateSnapshot(input: unknown): Snapshot {
  if (!plain(input) || !plain(input.manifest) || !plain(input.tables)) fail('备份格式错误');
  fields(input, ['manifest', 'tables']);
  fields(input.manifest, ['format', 'version', 'createdAt', 'credentials']);
  if (input.manifest.format !== 'qingji-backup' || input.manifest.version !== 1 || !integer(input.manifest.createdAt) || input.manifest.credentials !== 'preserve-target') fail('不支持的备份版本');
  fields(input.tables, ['owner', 'notes', 'attachments', 'note_attachments']);
  const owner = parseArray(input.tables.owner, '账号资料', 1);
  if (owner.length !== 1) fail('备份必须包含一份账号资料');
  fields(owner[0], ['display_name', 'settings_json']);
  if (typeof owner[0].display_name !== 'string' || !owner[0].display_name.trim() || owner[0].display_name.length > 80 || typeof owner[0].settings_json !== 'string' || owner[0].settings_json.length > 4096) fail('账号资料无效');
  try {
    const settings = JSON.parse(owner[0].settings_json as string);
    if (!plain(settings)) fail('设置无效');
    fields(settings, ['theme']);
    if (settings.theme !== undefined && !['system', 'light', 'dark'].includes(String(settings.theme))) fail('主题设置无效');
  } catch { fail('设置 JSON 或主题无效'); }
  const notes = parseArray(input.tables.notes, '笔记', 10000);
  const attachments = parseArray(input.tables.attachments, '附件', 2000);
  const links = parseArray(input.tables.note_attachments, '附件关联', 20000);
  const noteIds = new Set<string>();
  const fileIds = new Set<string>();
  for (const note of notes) {
    fields(note, ['id', 'content', 'tags_json', 'created_at', 'updated_at', 'archived_at', 'pinned', 'version']);
    if (typeof note.id !== 'string' || !UUID.test(note.id) || noteIds.has(note.id)) fail('笔记 ID 无效或重复');
    noteIds.add(note.id);
    if (typeof note.content !== 'string' || !note.content.trim() || encoder.encode(note.content).length > 100000 || typeof note.tags_json !== 'string' || note.tags_json.length > 8192) fail('笔记内容无效');
    let tags: unknown;
    try { tags = JSON.parse(note.tags_json); } catch { fail('标签 JSON 无效'); }
    if (!Array.isArray(tags) || tags.length > 100 || tags.some(tag => typeof tag !== 'string' || tag.length > 100)) fail('标签无效');
    if (!integer(note.created_at) || !integer(note.updated_at) || !(note.archived_at === null || integer(note.archived_at)) || ![0, 1].includes(note.pinned as number) || !integer(note.version) || (note.version as number) < 1) fail('笔记状态无效');
  }
  for (const file of attachments) {
    fields(file, ['id', 'filename', 'mime', 'size', 'sha256', 'status', 'created_at']);
    if (typeof file.id !== 'string' || !UUID.test(file.id) || fileIds.has(file.id)) fail('附件 ID 无效或重复');
    fileIds.add(file.id);
    if (typeof file.filename !== 'string' || !file.filename.trim() || file.filename.length > 240 || /[\x00-\x1f\x7f/\\]/.test(file.filename) || typeof file.mime !== 'string' || file.mime.length > 100 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(file.mime) || !integer(file.size) || (file.size as number) > MAX_FILE || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || file.status !== 'ready' || !integer(file.created_at)) fail('附件元数据无效');
  }
  const pairs = new Set<string>();
  for (const link of links) {
    fields(link, ['note_id', 'attachment_id']);
    if (typeof link.note_id !== 'string' || typeof link.attachment_id !== 'string' || !noteIds.has(link.note_id) || !fileIds.has(link.attachment_id)) fail('附件关联指向不存在的数据');
    const pair = `${link.note_id}/${link.attachment_id}`;
    if (pairs.has(pair)) fail('附件关联重复');
    pairs.add(pair);
  }
  if (encoder.encode(JSON.stringify(input)).length > MAX_METADATA) throw new BackupError(413, '备份元数据超过 8 MiB 容量上限');
  return input as unknown as Snapshot;
}
async function boundedBytes(request: Request, maximum: number): Promise<Uint8Array> {
  const length = request.headers.get('Content-Length');
  if (length && Number(length) > maximum) throw new BackupError(413, '请求超过容量上限');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maximum) { await reader.cancel(); throw new BackupError(413, '请求超过容量上限'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function jsonBody(request: Request, maximum = 1024): Promise<unknown> {
  try { return JSON.parse(new TextDecoder().decode(await boundedBytes(request, maximum))); }
  catch (error) { if (error instanceof BackupError) throw error; return fail('JSON 请求无效'); }
}
function tokenFrom(value: unknown): string {
  if (!plain(value) || typeof value.token !== 'string' || !/^(export|restore|abort):[0-9a-f-]{36}$/.test(value.token)) return fail('备份凭据无效');
  fields(value, ['token']);
  return value.token;
}
async function lockState(db: D1Database) {
  return db.prepare('SELECT maintenance, maintenance_token, maintenance_started_at FROM app_state WHERE id=1').first<{ maintenance: number; maintenance_token: string | null; maintenance_started_at: number | null }>();
}
async function requireLock(db: D1Database, token: string, mode: string) {
  const state = await lockState(db);
  if (state?.maintenance !== 1 || state.maintenance_token !== token || !token.startsWith(mode + ':')) throw new BackupError(409, '备份锁已失效，请检查维护状态');
}
const stageKey = (token: string) => `maintenance/${token.slice(token.indexOf(':') + 1)}/snapshot.json`;
const restorePrefix = (token: string) => `restores/${token.slice(token.indexOf(':') + 1)}/`;
async function stagedSnapshot(bucket: R2Bucket, token: string) {
  const object = await bucket.get(stageKey(token));
  if (!object) throw new BackupError(409, '恢复清单丢失，请释放维护状态后重试');
  return validateSnapshot(await object.json());
}
async function listRestoreFiles(bucket: R2Bucket, token: string) {
  const result: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: restorePrefix(token), limit: 1000, cursor, include: ['customMetadata'] });
    result.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return result;
}
function rowChunks(rows: Row[]) {
  const chunks: string[] = [];
  let current: Row[] = [];
  let bytes = 2;
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).length + 1;
    if (current.length && bytes + size > 400 * 1024) { chunks.push(JSON.stringify(current)); current = []; bytes = 2; }
    current.push(row); bytes += size;
  }
  if (current.length) chunks.push(JSON.stringify(current));
  return chunks;
}

export const backup = new Hono<AppEnv>();
backup.onError((error, c) => {
  if (error instanceof BackupError) return c.json({ error: { code: 'BACKUP_ERROR', message: error.message } }, error.status);
  console.error('Backup operation failed', error);
  return c.json({ error: { code: 'BACKUP_FAILED', message: '备份操作失败。原有数据未被覆盖，请检查维护状态后重试。' } }, 500);
});
backup.get('/status', async c => {
  const state = await lockState(c.env.DB);
  return c.json({ mode: state?.maintenance ? state.maintenance_token?.split(':')[0] : null, token: state?.maintenance ? state.maintenance_token : null, startedAt: state?.maintenance_started_at });
});
backup.post('/start', async c => {
  const token = `export:${crypto.randomUUID()}`;
  const acquired = await c.env.DB.prepare("UPDATE app_state SET maintenance=1,maintenance_token=?,maintenance_started_at=? WHERE id=1 AND maintenance=0 AND NOT EXISTS(SELECT 1 FROM attachments WHERE status!='ready') AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?)").bind(token, Date.now(), c.get('sessionHash'), Date.now()).run();
  if (acquired.meta.changes !== 1) throw new BackupError(409, '正在维护或附件操作尚未完成，请稍后重试');
  try {
    // Size in D1 before transferring rows into the 128 MiB Worker heap. Counting
    // JSON bytes includes escaping, rather than assuming content.length is safe.
    const sizes = await c.env.DB.batch<{ n: number; bytes: number }>([
      c.env.DB.prepare("SELECT count(*) n,coalesce(sum(length(CAST(json_object('display_name',display_name,'settings_json',settings_json) AS BLOB))),0) bytes FROM owner"),
      c.env.DB.prepare("SELECT count(*) n,coalesce(sum(length(CAST(json_object('id',id,'content',content,'tags_json',tags_json,'created_at',created_at,'updated_at',updated_at,'archived_at',archived_at,'pinned',pinned,'version',version) AS BLOB))),0) bytes FROM notes"),
      c.env.DB.prepare("SELECT count(*) n,coalesce(sum(length(CAST(json_object('id',id,'filename',filename,'mime',mime,'size',size,'sha256',sha256,'status',status,'created_at',created_at) AS BLOB))),0) bytes FROM attachments"),
      c.env.DB.prepare("SELECT count(*) n,coalesce(sum(length(CAST(json_object('note_id',note_id,'attachment_id',attachment_id) AS BLOB))),0) bytes FROM note_attachments"),
    ]);
    const totals = sizes.map(result => result.results[0]);
    if (totals[0].n !== 1 || totals[1].n > 10000 || totals[2].n > 2000 || totals[3].n > 20000 || totals.reduce((sum, value) => sum + value.bytes + value.n, 512) > MAX_METADATA) throw new BackupError(413, '数据超过单次备份容量（8 MiB 元数据、10000 条笔记、2000 个附件）');
    const tables = await c.env.DB.batch([
      c.env.DB.prepare('SELECT display_name,settings_json FROM owner WHERE id=1'),
      c.env.DB.prepare('SELECT id,content,tags_json,created_at,updated_at,archived_at,pinned,version FROM notes ORDER BY id LIMIT 10001'),
      c.env.DB.prepare("SELECT id,filename,mime,size,sha256,status,created_at FROM attachments WHERE status='ready' ORDER BY id LIMIT 2001"),
      c.env.DB.prepare('SELECT note_id,attachment_id FROM note_attachments ORDER BY note_id,attachment_id LIMIT 20001'),
    ]);
    const snapshot = validateSnapshot({ manifest: { format: 'qingji-backup', version: 1, createdAt: Date.now(), credentials: 'preserve-target' }, tables: { owner: tables[0].results, notes: tables[1].results, attachments: tables[2].results, note_attachments: tables[3].results } });
    return c.json({ token, ...snapshot });
  } catch (error) {
    await c.env.DB.prepare('UPDATE app_state SET maintenance=0,maintenance_token=NULL,maintenance_started_at=NULL WHERE maintenance_token=?').bind(token).run();
    throw error;
  }
});
backup.post('/finish', async c => {
  const token = tokenFrom(await jsonBody(c.req.raw));
  await requireLock(c.env.DB, token, 'export');
  const released = await c.env.DB.prepare('UPDATE app_state SET maintenance=0,maintenance_token=NULL,maintenance_started_at=NULL WHERE maintenance_token=? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?)').bind(token, c.get('sessionHash'), Date.now()).run();
  if (released.meta.changes !== 1) throw new BackupError(409, '维护状态或登录会话已变化');
  return c.json({ released: true });
});
backup.post('/restore/start', async c => {
  const snapshot = validateSnapshot(await jsonBody(c.req.raw, MAX_METADATA));
  const token = `restore:${crypto.randomUUID()}`;
  const result = await c.env.DB.prepare('UPDATE app_state SET maintenance=1,maintenance_token=?,maintenance_started_at=? WHERE id=1 AND maintenance=0 AND EXISTS(SELECT 1 FROM owner WHERE id=1) AND NOT EXISTS(SELECT 1 FROM notes) AND NOT EXISTS(SELECT 1 FROM attachments) AND NOT EXISTS(SELECT 1 FROM note_attachments) AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?)').bind(token, Date.now(), c.get('sessionHash'), Date.now()).run();
  if (result.meta.changes !== 1) throw new BackupError(409, '只允许恢复到已建号、没有笔记和附件、未维护的空应用');
  try { await c.env.FILES.put(stageKey(token), JSON.stringify(snapshot), { httpMetadata: { contentType: 'application/json' } }); }
  catch (error) { await c.env.DB.prepare('UPDATE app_state SET maintenance=0,maintenance_token=NULL,maintenance_started_at=NULL WHERE maintenance_token=?').bind(token).run(); throw error; }
  return c.json({ token });
});
backup.put('/restore/files/:id', async c => {
  const token = tokenFrom({ token: c.req.header('X-Backup-Token') });
  await requireLock(c.env.DB, token, 'restore');
  const snapshot = await stagedSnapshot(c.env.FILES, token);
  const file = snapshot.tables.attachments.find(item => item.id === c.req.param('id'));
  if (!file) throw new BackupError(400, '该附件不在恢复清单中');
  const bytes = await boundedBytes(c.req.raw, MAX_FILE);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (bytes.length !== file.size || digest !== file.sha256) throw new BackupError(400, '附件校验失败，未写入');
  const key = restorePrefix(token) + file.id;
  await c.env.FILES.put(key, bytes, { sha256: digest, customMetadata: { sha256: digest }, httpMetadata: { contentType: String(file.mime) } });
  try { await requireLock(c.env.DB, token, 'restore'); }
  catch (error) {
    // A duplicate upload may finish after commit. Its object is already live and
    // must not be mistaken for abandoned staging data.
    const live = await c.env.DB.prepare('SELECT id FROM attachments WHERE object_key=?').bind(key).first();
    if (!live) await c.env.FILES.delete(key);
    throw error;
  }
  return c.json({ uploaded: true, id: file.id });
});
backup.post('/restore/commit', async c => {
  const token = tokenFrom(await jsonBody(c.req.raw));
  await requireLock(c.env.DB, token, 'restore');
  const snapshot = await stagedSnapshot(c.env.FILES, token);
  const objects = new Map((await listRestoreFiles(c.env.FILES, token)).map(item => [item.key, item]));
  for (const file of snapshot.tables.attachments) {
    const object = objects.get(restorePrefix(token) + file.id);
    if (!object || object.size !== file.size || object.customMetadata?.sha256 !== file.sha256) throw new BackupError(409, '还有附件未上传或校验不匹配，恢复未提交');
  }
  // The guard errors (instead of silently affecting zero rows) if a concurrent release won.
  // D1 batch is atomic: no other request sees the temporary unlocked state.
  const batch: D1PreparedStatement[] = [
    c.env.DB.prepare('UPDATE app_state SET maintenance=CASE WHEN maintenance=1 AND maintenance_token=? AND NOT EXISTS(SELECT 1 FROM notes) AND NOT EXISTS(SELECT 1 FROM attachments) AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?) THEN 0 ELSE NULL END WHERE id=1').bind(token, c.get('sessionHash'), Date.now()),
    c.env.DB.prepare('UPDATE owner SET display_name=?,settings_json=?,updated_at=? WHERE id=1').bind(snapshot.tables.owner[0].display_name, snapshot.tables.owner[0].settings_json, Date.now()),
  ];
  for (const chunk of rowChunks(snapshot.tables.notes)) batch.push(c.env.DB.prepare("INSERT INTO notes(id,content,tags_json,created_at,updated_at,archived_at,pinned,version) SELECT json_extract(value,'$.id'),json_extract(value,'$.content'),json_extract(value,'$.tags_json'),json_extract(value,'$.created_at'),json_extract(value,'$.updated_at'),json_extract(value,'$.archived_at'),json_extract(value,'$.pinned'),json_extract(value,'$.version') FROM json_each(?)").bind(chunk));
  const attachments = snapshot.tables.attachments.map(file => ({ ...file, object_key: restorePrefix(token) + file.id }));
  for (const chunk of rowChunks(attachments)) batch.push(c.env.DB.prepare("INSERT INTO attachments(id,object_key,filename,mime,size,sha256,status,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.object_key'),json_extract(value,'$.filename'),json_extract(value,'$.mime'),json_extract(value,'$.size'),json_extract(value,'$.sha256'),'ready',json_extract(value,'$.created_at') FROM json_each(?)").bind(chunk));
  for (const chunk of rowChunks(snapshot.tables.note_attachments)) batch.push(c.env.DB.prepare("INSERT INTO note_attachments(note_id,attachment_id) SELECT json_extract(value,'$.note_id'),json_extract(value,'$.attachment_id') FROM json_each(?)").bind(chunk));
  batch.push(c.env.DB.prepare('DELETE FROM sessions'), c.env.DB.prepare('UPDATE app_state SET maintenance_token=NULL,maintenance_started_at=NULL WHERE id=1'));
  if (batch.length > 45) throw new BackupError(413, '备份超过单次原子恢复容量，尚未提交');
  await c.env.DB.batch(batch);
  // A leftover manifest is harmless; successful database commit must not be reported as failure.
  try { await c.env.FILES.delete(stageKey(token)); } catch (error) { console.error('Restore manifest cleanup failed', error); }
  return c.json({ restored: true, notes: snapshot.tables.notes.length, attachments: attachments.length, signInAgain: true });
});
backup.post('/release', async c => {
  const token = tokenFrom(await jsonBody(c.req.raw));
  const state = await lockState(c.env.DB);
  if (!state?.maintenance) return c.json({ released: true });
  if (state.maintenance_token !== token) throw new BackupError(409, '维护凭据已变化，请重新读取状态');
  if (token.startsWith('export:')) {
    const released = await c.env.DB.prepare('UPDATE app_state SET maintenance=0,maintenance_token=NULL,maintenance_started_at=NULL WHERE maintenance_token=? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?)').bind(token, c.get('sessionHash'), Date.now()).run();
    if (released.meta.changes !== 1) throw new BackupError(409, '维护状态或登录会话已变化');
  } else {
    const abortToken = `abort:${token.split(':')[1]}`;
    const changed = await c.env.DB.prepare('UPDATE app_state SET maintenance_token=? WHERE maintenance=1 AND maintenance_token=? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?)').bind(abortToken, token, c.get('sessionHash'), Date.now()).run();
    if (changed.meta.changes !== 1) throw new BackupError(409, '维护状态已变化');
    const objects = await listRestoreFiles(c.env.FILES, abortToken);
    for (let offset = 0; offset < objects.length; offset += 1000) await c.env.FILES.delete(objects.slice(offset, offset + 1000).map(object => object.key));
    await c.env.FILES.delete(stageKey(abortToken));
    await c.env.DB.prepare('UPDATE app_state SET maintenance=0,maintenance_token=NULL,maintenance_started_at=NULL WHERE maintenance_token=?').bind(abortToken).run();
  }
  return c.json({ released: true });
});

export default backup;
