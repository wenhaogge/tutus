import { Hono, type Context } from 'hono';
import { ApiError, assertWritable, jsonBody, randomToken } from './auth';
import { serveFile, type FileRow } from './files';
import type { AppEnv } from './types';

type Ctx = Context<AppEnv>;
const SHARE_MS = 24 * 60 * 60 * 1000;
const tokenPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface ShareRow { token: string; expires_at: number }
interface PublicNoteRow { content: string; created_at: number; updated_at: number; expires_at: number }
interface SharedFileRow extends FileRow { id: string }

/** Authenticated, same-origin route. An active link is reused without extending it. */
export async function createShare(c: Ctx) {
  await assertWritable(c);
  if ([...new URL(c.req.url).searchParams].length) throw new ApiError(400, 'INVALID_ARGUMENT', '分享不支持查询条件。');
  await jsonBody(c, []);
  const id = c.req.param('id');
  if (!id || !idPattern.test(id)) throw new ApiError(400, 'INVALID_ARGUMENT', '无效的记录编号。');
  const now = Date.now();
  const results = await c.env.DB.batch([
    // Fence at commit, including requests that were authorized before a restore.
    c.env.DB.prepare('UPDATE app_state SET maintenance=CASE WHEN maintenance=0 AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?) THEN 0 ELSE NULL END WHERE id=1').bind(c.get('sessionHash'), now),
    c.env.DB.prepare(`INSERT INTO note_shares(note_id,token,expires_at)
      SELECT id,?,? FROM notes WHERE id=?
      ON CONFLICT(note_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
      WHERE note_shares.expires_at<=?`).bind(randomToken(), now + SHARE_MS, id, now),
    c.env.DB.prepare('SELECT token,expires_at FROM note_shares WHERE note_id=?').bind(id),
  ]);
  const share = results[2].results[0] as unknown as ShareRow | undefined;
  if (!share) throw new ApiError(404, 'NOT_FOUND', '笔记不存在。');
  return c.json({ share: { url: `/s/${share.token}`, expiresAt: share.expires_at } });
}

function validPath(c: Ctx): boolean {
  return tokenPattern.test(c.req.param('token') ?? '') && ![...new URL(c.req.url).searchParams].length;
}
function notFound(c: Ctx, html = false) {
  if (html) {
    const body = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>分享链接不可用 · Link unavailable</title><body><main><h1>分享链接不可用</h1><p>链接不存在或已过期。</p><h2>Share link unavailable</h2><p>This link does not exist or has expired.</p></main></body></html>';
    c.header('Content-Type', 'text/html; charset=utf-8');
    if (c.req.method === 'HEAD') return c.body(null, 404);
    return c.body(body, 404);
  }
  return c.json({ error: { code: 'SHARE_UNAVAILABLE', message: '分享链接不可用或已过期。 Share link unavailable or expired.' } }, 404);
}

const share = new Hono<AppEnv>();
share.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  await next();
});
share.on(['GET', 'HEAD'], '/:token', async c => {
  if (!validPath(c)) return notFound(c, true);
  const active = await c.env.DB.prepare(`SELECT 1 FROM note_shares s JOIN notes n ON n.id=s.note_id
    WHERE s.token=? AND s.expires_at>?`).bind(c.req.param('token'), Date.now()).first();
  if (!active) return notFound(c, true);
  // Serve only the public application shell; strip original cookies and conditional headers.
  const response = await c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), { method: 'GET' }));
  if (!response.ok || !response.body) throw new ApiError(503, 'PAGE_UNAVAILABLE', '分享页面暂时不可用，请稍后重试。');
  c.header('Content-Type', 'text/html; charset=utf-8');
  if (c.req.method === 'HEAD') return c.body(null, 200);
  return c.body(response.body, 200);
});
share.get('/:token/note', async c => {
  if (!validPath(c)) return notFound(c);
  const token = c.req.param('token'), now = Date.now();
  const [notes, files] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT n.content,n.created_at,n.updated_at,s.expires_at FROM note_shares s
      JOIN notes n ON n.id=s.note_id WHERE s.token=? AND s.expires_at>?`).bind(token, now),
    c.env.DB.prepare(`SELECT a.id,a.filename,a.mime,a.size FROM note_shares s
      JOIN note_attachments na ON na.note_id=s.note_id JOIN attachments a ON a.id=na.attachment_id
      WHERE s.token=? AND s.expires_at>? AND a.status='ready' ORDER BY a.created_at,a.id`).bind(token, now),
  ]);
  const note = notes.results[0] as unknown as PublicNoteRow | undefined;
  if (!note) return notFound(c);
  return c.json({ note: { content: note.content, createdAt: note.created_at, updatedAt: note.updated_at,
    attachments: (files.results as unknown as SharedFileRow[]).map(a => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: `/s/${token}/files/${a.id}` })) }, expiresAt: note.expires_at });
});
share.on(['GET', 'HEAD'], '/:token/files/:id', async c => {
  if (!validPath(c) || !idPattern.test(c.req.param('id'))) return notFound(c);
  const row = await c.env.DB.prepare(`SELECT a.* FROM note_shares s
    JOIN notes n ON n.id=s.note_id JOIN note_attachments na ON na.note_id=n.id
    JOIN attachments a ON a.id=na.attachment_id
    WHERE s.token=? AND s.expires_at>? AND a.id=? AND a.status='ready'`)
    .bind(c.req.param('token'), Date.now(), c.req.param('id')).first<SharedFileRow>();
  if (!row) return notFound(c);
  return serveFile(c, row);
});
share.all('*', c => notFound(c));

export default share;
