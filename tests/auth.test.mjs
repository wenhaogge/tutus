import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHarness } from './helpers.mjs';

function cookieOf(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'successful authentication must set a cookie');
  return header.split(';')[0];
}

test('single-owner authentication, CSRF, session revocation, and safe maintenance', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const login = (password = h.password, username = h.username) => h.request('/api/auth/login', {
    method: 'POST', cookie: '', body: { username, password },
  });

  await t.test('before setup no account or private notes are exposed', async () => {
    const status = await h.request('/api/auth/status', { cookie: '' });
    assert.deepEqual(await status.json(), { needsSetup: true, user: null });
    assert.equal((await h.request('/api/notes', { cookie: '' })).status, 401);
    assert.equal((await h.request('/api/settings', { cookie: '' })).status, 401);
    assert.equal((await h.request('/files/unknown', { cookie: '' })).status, 401);
  });

  await t.test('cross-origin and absent-origin setup do not establish an account', async () => {
    const body = { setupSecret: h.setupSecret, username: h.username, password: h.password, displayName: '个人笔记' };
    const cross = await h.request('/api/auth/setup', { method: 'POST', body, headers: { Origin: 'https://evil.invalid' } });
    assert.equal(cross.status, 403);
    const absent = await h.request('/api/auth/setup', { method: 'POST', body, origin: false });
    assert.equal(absent.status, 403);
    assert.equal(await h.db.prepare('SELECT id FROM owner').first(), null);
  });

  await t.test('setup rejects unsupported fields and bcrypt truncation', async () => {
    const base = { setupSecret: h.setupSecret, username: h.username, password: h.password, displayName: '个人笔记' };
    const extra = await h.request('/api/auth/setup', { method: 'POST', body: { ...base, publicRegistration: true } });
    assert.equal(extra.status, 400);
    const truncated = await h.request('/api/auth/setup', { method: 'POST', body: { ...base, password: '长'.repeat(25) } });
    assert.equal(truncated.status, 400);
    const wrongSecret = await h.request('/api/auth/setup', { method: 'POST', body: { ...base, setupSecret: 'wrong' } });
    assert.equal(wrongSecret.status, 403);
    assert.equal(await h.db.prepare('SELECT id FROM owner').first(), null);
  });

  let firstCookie;
  await t.test('setup stores a bcrypt hash and a hashed random session, then closes registration', async () => {
    const setup = await h.setup();
    assert.equal(setup.status, 201);
    firstCookie = cookieOf(setup);
    assert.match(setup.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(setup.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.doesNotMatch(setup.headers.get('set-cookie'), /Domain=/i);
    const owner = await h.db.prepare('SELECT * FROM owner').first();
    assert.match(owner.password_hash, /^\$2[aby]\$12\$/);
    assert.notEqual(owner.password_hash, h.password);
    const rawToken = firstCookie.split('=')[1];
    assert.match(rawToken, /^[a-f0-9]{64}$/);
    const session = await h.db.prepare('SELECT * FROM sessions').first();
    assert.equal(session.token_hash, createHash('sha256').update(rawToken).digest('hex'));
    assert.notEqual(session.token_hash, rawToken);
    const repeat = await h.request('/api/auth/setup', { method: 'POST', body: { setupSecret: h.setupSecret, username: 'intruder', password: h.password } });
    assert.equal(repeat.status, 409);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM owner').first()).n, 1);
    const visible = await (await h.request('/api/auth/status')).text();
    assert.ok(visible.includes(h.username));
    assert.ok(!visible.includes(owner.password_hash));
    assert.ok(!visible.includes(rawToken));
  });

  let secondCookie;
  await t.test('invalid login is generic and valid login creates an independent session', async () => {
    const badUsername = await login(h.password, 'not-owner');
    const badPassword = await login('wrong-password');
    assert.equal(badUsername.status, 401);
    assert.equal(badPassword.status, 401);
    assert.deepEqual(await badUsername.json(), await badPassword.json());
    const valid = await login();
    assert.equal(valid.status, 200);
    secondCookie = cookieOf(valid);
    assert.notEqual(secondCookie, firstCookie);
    const forged = await h.request('/api/notes', { cookie: 'qingji_session=' + '0'.repeat(64) });
    assert.equal(forged.status, 401);
  });

  const changedPassword = 'New-correct-password-5678';
  await t.test('password change invalidates other sessions and old credentials immediately', async () => {
    const changed = await h.request('/api/auth/password', { method: 'POST', cookie: secondCookie, body: { currentPassword: h.password, newPassword: changedPassword } });
    assert.equal(changed.status, 200);
    assert.equal((await h.request('/api/notes', { cookie: firstCookie })).status, 401);
    assert.equal((await h.request('/api/notes', { cookie: secondCookie })).status, 200);
    assert.equal((await login()).status, 401);
    const current = await login(changedPassword);
    assert.equal(current.status, 200);
    h.cookie = cookieOf(current);
  });

  await t.test('authenticated cross-site writes and unknown fields fail closed', async () => {
    const cross = await h.request('/api/auth/password', { method: 'POST', body: { currentPassword: changedPassword, newPassword: h.password }, headers: { Origin: 'https://evil.invalid' } });
    assert.equal(cross.status, 403);
    const fields = await h.request('/api/auth/logout', { method: 'POST', body: { ignoreMe: true } });
    assert.equal(fields.status, 400);
    assert.equal((await h.request('/api/notes')).status, 200);
  });

  await t.test('backup lock rejects business writes at both API and database boundaries', async () => {
    await h.db.prepare('UPDATE app_state SET maintenance=1,maintenance_token=? WHERE id=1').bind('test-maintenance-lock').run();
    try {
      const password = await h.request('/api/auth/password', { method: 'POST', body: { currentPassword: changedPassword, newPassword: h.password } });
      assert.equal(password.status, 503);
      await assert.rejects(() => h.db.prepare('UPDATE owner SET display_name=? WHERE id=1').bind('blocked').run(), /maintenance/);
      await assert.rejects(() => h.db.prepare('INSERT INTO notes(id,content,created_at,updated_at) VALUES(?,?,?,?)').bind('blocked', 'blocked', 1, 1).run(), /maintenance/);
      assert.equal((await h.request('/api/auth/status')).status, 200);
    } finally {
      await h.db.prepare('UPDATE app_state SET maintenance=0,maintenance_token=NULL WHERE id=1').run();
    }
  });

  await t.test('logout immediately revokes the server-side session', async () => {
    const cookie = h.cookie;
    const logout = await h.request('/api/auth/logout', { method: 'POST', body: {} });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i);
    assert.equal((await h.request('/api/notes', { cookie })).status, 401);
  });

  await t.test('expired sessions are rejected and authentication is durably rate-limited', async () => {
    await h.db.prepare('UPDATE sessions SET expires_at=0').run();
    assert.equal((await h.request('/api/notes', { cookie: secondCookie })).status, 401);
    await h.db.prepare("INSERT INTO auth_limits(key,count,reset_at) VALUES('login:global',40,?) ON CONFLICT(key) DO UPDATE SET count=40,reset_at=excluded.reset_at").bind(Date.now() + 900_000).run();
    const limited = await login(changedPassword);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  });
});

test('concurrent first-time setup atomically creates exactly one owner and session', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const attempts = await Promise.all(['first-owner', 'second-owner'].map((username) => h.request('/api/auth/setup', {
    method: 'POST', cookie: '', body: { username, setupSecret: h.setupSecret, password: h.password, displayName: username },
  })));
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await h.db.prepare('SELECT count(*) AS n FROM owner').first()).n, 1);
  assert.equal((await h.db.prepare('SELECT count(*) AS n FROM sessions').first()).n, 1);
});

test('production cookies are HTTPS-only and cleartext production requests are rejected', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const origin = 'https://qingji.example';
  const setup = await h.mf.dispatchFetch(origin + '/api/auth/setup', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: h.username, password: h.password, setupSecret: h.setupSecret }),
  });
  assert.equal(setup.status, 201);
  const cookie = cookieOf(setup);
  assert.match(cookie, /^__Host-qingji_session=/);
  assert.match(setup.headers.get('set-cookie'), /(?:^|;)\s*Secure(?:;|$)/i);
  assert.match(setup.headers.get('set-cookie'), /Path=\//i);
  assert.doesNotMatch(setup.headers.get('set-cookie'), /Domain=/i);
  assert.match(setup.headers.get('strict-transport-security'), /max-age=/);
  assert.equal((await h.mf.dispatchFetch(origin + '/api/notes', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await h.mf.dispatchFetch('http://qingji.example/api/auth/login', {
    method: 'POST', headers: { Origin: 'http://qingji.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: h.username, password: h.password }),
  })).status, 400);
});
