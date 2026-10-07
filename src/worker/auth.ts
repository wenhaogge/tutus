import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import bcrypt from 'bcryptjs';
import type { AppEnv, OwnerRow } from './types';

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;
const encoder = new TextEncoder();
type Ctx = Context<AppEnv>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function sha256(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) => v.toString(16).padStart(2, '0')).join('');
}

export function sameOrigin(c: Ctx): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return;
  const origin = c.req.header('Origin');
  if (origin !== new URL(c.req.url).origin) {
    throw new ApiError(403, 'ORIGIN_REJECTED', '请求来源不受信任，请重新打开应用。');
  }
  const site = c.req.header('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new ApiError(403, 'ORIGIN_REJECTED', '不允许跨站请求。');
  }
}

/** Stream bounded JSON rather than trusting Content-Length. Reject unsupported fields. */
export async function jsonBody(c: Ctx, allowed: readonly string[], maxBytes = 16384): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
    throw new ApiError(415, 'JSON_REQUIRED', '请发送 JSON 请求。');
  }
  const declared = Number(c.req.header('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大。');
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大。');
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'JSON 格式无效。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_BODY', '请求必须是一个对象。');
  const invalid = Object.keys(body).find((key) => !allowed.includes(key));
  if (invalid) throw new ApiError(400, 'UNKNOWN_FIELD', `不支持的字段：${invalid}`);
  return body as Record<string, unknown>;
}

function textField(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) {
    throw new ApiError(400, 'INVALID_FIELD', `${name}不能为空，且不能超过 ${max} 个字符。`);
  }
  return value.trim();
}

function passwordField(value: unknown, fresh = false): string {
  if (typeof value !== 'string' || !value.length || bcrypt.truncates(value) || (fresh && [...value].length < 12)) {
    throw new ApiError(400, 'INVALID_PASSWORD', '密码须至少 12 个字符且 UTF-8 编码不超过 72 字节，请使用长且唯一的密码。');
  }
  return value;
}

function cookieName(c: Ctx): string {
  return new URL(c.req.url).protocol === 'https:' ? '__Host-qingji_session' : 'qingji_session';
}

function writeCookie(c: Ctx, token: string): void {
  setCookie(c, cookieName(c), token, {
    path: '/', httpOnly: true, sameSite: 'Strict', secure: new URL(c.req.url).protocol === 'https:',
    maxAge: Math.floor(SESSION_MS / 1000),
  });
}

async function activeSession(c: Ctx): Promise<string | null> {
  const token = getCookie(c, cookieName(c));
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hashed = await sha256(token);
  const session = await c.env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>? AND EXISTS (SELECT 1 FROM owner WHERE id=1)').bind(hashed, Date.now()).first();
  return session ? hashed : null;
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const hashed = await activeSession(c);
  if (!hashed) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录。');
  c.set('sessionHash', hashed);
  await next();
});

export async function assertWritable(c: Ctx): Promise<void> {
  const state = await c.env.DB.prepare('SELECT maintenance FROM app_state WHERE id=1').first<{ maintenance: number }>();
  if (state?.maintenance) throw new ApiError(503, 'MAINTENANCE', '正在备份或恢复，请稍后重试。草稿不会丢失。');
}

export function publicUser(owner: OwnerRow) {
  return { username: owner.username, displayName: owner.display_name, settings: JSON.parse(owner.settings_json) as Record<string, unknown> };
}

export async function getUser(c: Ctx) {
  const owner = await c.env.DB.prepare('SELECT * FROM owner WHERE id=1').first<OwnerRow>();
  if (!owner) throw new ApiError(401, 'UNAUTHENTICATED', '请先初始化账号。');
  return publicUser(owner);
}

async function rateLimit(c: Ctx, action: string): Promise<void> {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  // CF-Connecting-IP is overwritten by Cloudflare; local development shares a bucket.
  const ipHash = await sha256(c.req.header('CF-Connecting-IP') || 'local');
  const buckets = [{ key: `${action}:ip:${ipHash}`, max: action === 'setup' ? 5 : 8 }, { key: `${action}:global`, max: action === 'setup' ? 20 : 40 }];
  const statements = buckets.map(({ key }) => c.env.DB.prepare(`INSERT INTO auth_limits(key,count,reset_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count,reset_at`).bind(key, now + windowMs, now, now));
  const results = await c.env.DB.batch<{ count: number; reset_at: number }>(statements);
  for (let i = 0; i < results.length; i++) {
    const bucket = results[i].results[0];
    if (bucket.count > buckets[i].max) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((bucket.reset_at - now) / 1000))));
      throw new ApiError(429, 'RATE_LIMITED', '尝试次数过多，请 15 分钟后重试。');
    }
  }
  await c.env.DB.prepare('DELETE FROM auth_limits WHERE reset_at<?').bind(now).run();
}

const auth = new Hono<AppEnv>();
auth.use('*', async (c, next) => { sameOrigin(c); c.header('Cache-Control', 'no-store'); await next(); });

auth.get('/status', async (c) => {
  const owner = await c.env.DB.prepare('SELECT * FROM owner WHERE id=1').first<OwnerRow>();
  const loggedIn = owner && await activeSession(c);
  return c.json({ needsSetup: !owner, user: loggedIn ? publicUser(owner) : null });
});

auth.post('/setup', async (c) => {
  if (await c.env.DB.prepare('SELECT id FROM owner WHERE id=1').first()) throw new ApiError(409, 'ALREADY_SETUP', '账号已经建立，公开注册已关闭。');
  await assertWritable(c);
  const body = await jsonBody(c, ['setupSecret', 'username', 'password', 'displayName']);
  await rateLimit(c, 'setup');
  if (!c.env.SETUP_SECRET || c.env.SETUP_SECRET.length < 32) throw new ApiError(503, 'SETUP_UNAVAILABLE', '请先配置至少 32 字符的随机初始化密钥。');
  if (typeof body.setupSecret !== 'string' || await sha256(body.setupSecret) !== await sha256(c.env.SETUP_SECRET)) {
    throw new ApiError(403, 'INVALID_SETUP_SECRET', '初始化密钥不正确。');
  }
  const username = textField(body.username, '用户名', 32);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,31}$/u.test(username)) throw new ApiError(400, 'INVALID_USERNAME', '用户名须为 3–32 个字母、数字、下划线、点或短横线。');
  const displayName = textField(body.displayName ?? username, '显示名称', 80);
  const password = passwordField(body.password, true);
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const token = randomToken();
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO owner(id,username,password_hash,display_name,settings_json,created_at,updated_at) VALUES(1,?,?,?,?,?,?)').bind(username, passwordHash, displayName, '{}', now, now),
      c.env.DB.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').bind(await sha256(token), now + SESSION_MS, now),
    ]);
  } catch (error) {
    if (await c.env.DB.prepare('SELECT id FROM owner WHERE id=1').first()) throw new ApiError(409, 'ALREADY_SETUP', '账号已经建立，公开注册已关闭。');
    throw error;
  }
  writeCookie(c, token);
  return c.json({ user: await getUser(c) }, 201);
});

auth.post('/login', async (c) => {
  const body = await jsonBody(c, ['username', 'password']);
  const username = textField(body.username, '用户名', 32);
  const password = passwordField(body.password);
  await rateLimit(c, 'login');
  const owner = await c.env.DB.prepare('SELECT * FROM owner WHERE id=1').first<OwnerRow>();
  if (!owner) throw new ApiError(409, 'NEEDS_SETUP', '请先初始化账号。');
  // Always compare against the owner's real hash even when the username is wrong.
  const valid = await bcrypt.compare(password, owner.password_hash);
  if (!valid || username !== owner.username) throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确。');
  const token = randomToken();
  const now = Date.now();
  const inserted = await c.env.DB.prepare(`INSERT INTO sessions(token_hash,expires_at,created_at)
    SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM owner WHERE id=1 AND password_hash=?) RETURNING token_hash`)
    .bind(await sha256(token), now + SESSION_MS, now, owner.password_hash).first();
  if (!inserted) throw new ApiError(409, 'CREDENTIALS_CHANGED', '密码刚刚更改，请重新登录。');
  await c.env.DB.prepare('DELETE FROM sessions WHERE expires_at<=? OR token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY created_at DESC,token_hash LIMIT 20)').bind(now).run();
  writeCookie(c, token);
  return c.json({ user: publicUser(owner) });
});

auth.post('/logout', requireAuth, async (c) => {
  await jsonBody(c, []);
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(c.get('sessionHash')).run();
  deleteCookie(c, cookieName(c), { path: '/', httpOnly: true, sameSite: 'Strict', secure: new URL(c.req.url).protocol === 'https:' });
  return c.json({ ok: true });
});

auth.post('/password', requireAuth, async (c) => {
  await assertWritable(c);
  const body = await jsonBody(c, ['currentPassword', 'newPassword']);
  const currentPassword = passwordField(body.currentPassword);
  const newPassword = passwordField(body.newPassword, true);
  await rateLimit(c, 'password');
  const owner = await c.env.DB.prepare('SELECT * FROM owner WHERE id=1').first<OwnerRow>();
  if (!owner || !await bcrypt.compare(currentPassword, owner.password_hash)) throw new ApiError(401, 'INVALID_PASSWORD', '当前密码不正确。');
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const now = Date.now();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE owner SET password_hash=?,updated_at=? WHERE id=1 AND password_hash=?
      AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?) RETURNING id`).bind(passwordHash, now, owner.password_hash, c.get('sessionHash'), now),
    c.env.DB.prepare('DELETE FROM sessions WHERE token_hash<>? AND EXISTS(SELECT 1 FROM owner WHERE id=1 AND password_hash=?)').bind(c.get('sessionHash'), passwordHash),
  ]);
  if (!results[0].results.length) throw new ApiError(409, 'CREDENTIALS_CHANGED', '账号状态已变化，请重新登录后重试。');
  return c.json({ ok: true, otherSessionsRevoked: true });
});

export default auth;
