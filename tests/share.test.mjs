import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createHarness } from './helpers.mjs';

const DAY = 24 * 60 * 60 * 1000;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8sAAAAASUVORK5CYII=', 'base64');
const anonymous = { cookie: '', origin: false };

async function upload(h, bytes = png, filename = '分享图片.png', mime = 'image/png') {
  const response = await h.request('/api/attachments', {
    method: 'POST', body: bytes,
    headers: { 'Content-Type': mime, 'X-Filename': encodeURIComponent(filename), 'X-Upload-Id': randomUUID() },
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).attachment;
}

async function createNote(h, content, attachments = []) {
  const response = await h.request('/api/notes', {
    method: 'POST', body: { content, attachmentIds: attachments.map(file => file.id) },
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).note;
}

async function share(h, note) {
  const response = await h.request(`/api/notes/${note.id}/share`, { method: 'POST', body: {} });
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()).share;
  assert.match(result.url, /^\/s\/[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(result.expiresAt));
  return result;
}

function privateHeaders(response) {
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
}

test('24-hour share capability grants read-only access to exactly one note and its current attachments', async t => {
  const h = await createHarness();
  t.after(() => h.close());
  assert.equal((await h.setup()).status, 201);
  const image = await upload(h);
  const otherImage = await upload(h, Buffer.from('other private bytes'), '私人文件.txt', 'text/plain');
  const html = await upload(h, Buffer.from('<script>alert("untrusted attachment")</script>'), '页面.html', 'text/html');
  let note = await createNote(h, `公开这一条 #分享\n\n![图片](${image.url})`, [image, html]);
  const other = await createNote(h, '只属于另一篇的私人内容 #保密', [otherImage]);
  let active;

  await t.test('new notes stay private and creating shares requires owner, origin and an unlocked database', async () => {
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM note_shares').first()).n, 0);
    for (const path of [`/api/notes/${note.id}`, image.url, otherImage.url]) {
      assert.equal((await h.request(path, anonymous)).status, 401);
    }
    const endpoint = `/api/notes/${note.id}/share`;
    assert.equal((await h.request(endpoint, { method: 'POST', body: {}, cookie: '' })).status, 401);
    assert.equal((await h.request(endpoint, { method: 'POST', body: {}, cookie: 'qingji_session=forged' })).status, 401);
    assert.equal((await h.request(endpoint, { method: 'POST', body: {}, origin: false })).status, 403);
    assert.equal((await h.request(endpoint, { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await h.request(endpoint, { method: 'POST', body: { expiresAt: Date.now() + 365 * DAY } })).status, 400);
    await h.db.prepare('UPDATE app_state SET maintenance=1 WHERE id=1').run();
    try {
      assert.equal((await h.request(endpoint, { method: 'POST', body: {} })).status, 503);
    } finally {
      await h.db.prepare('UPDATE app_state SET maintenance=0 WHERE id=1').run();
    }
    assert.equal((await h.request(`/api/notes/${randomUUID()}/share`, { method: 'POST', body: {} })).status, 404);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM note_shares').first()).n, 0);
  });

  await t.test('first request fixes expiry at 24 hours and repeated or concurrent requests never extend it', async () => {
    const before = Date.now();
    const issued = await Promise.all(Array.from({ length: 6 }, () => share(h, note)));
    const after = Date.now();
    active = issued[0];
    assert.ok(active.expiresAt >= before + DAY && active.expiresAt <= after + DAY);
    for (const value of issued) assert.deepEqual(value, active);
    assert.deepEqual(await share(h, note), active);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM note_shares WHERE note_id=?').bind(note.id).first()).n, 1);
    const row = await h.db.prepare('SELECT token,expires_at FROM note_shares WHERE note_id=?').bind(note.id).first();
    assert.equal(active.url, '/s/' + row.token);
    assert.equal(active.expiresAt, row.expires_at);
  });

  await t.test('anonymous HTML and minimal JSON expose only this note without private account metadata', async () => {
    const page = await h.request(active.url, anonymous);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    privateHeaders(page);
    const head = await h.request(active.url, { ...anonymous, method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    privateHeaders(head);
    const response = await h.request(active.url + '/note', anonymous);
    assert.equal(response.status, 200);
    privateHeaders(response);
    const data = await response.json();
    assert.deepEqual(Object.keys(data).sort(), ['expiresAt', 'note']);
    assert.deepEqual(Object.keys(data.note).sort(), ['attachments', 'content', 'createdAt', 'updatedAt']);
    assert.equal(data.note.content, note.content);
    assert.equal(data.expiresAt, active.expiresAt);
    assert.equal(data.note.attachments.length, 2);
    for (const file of data.note.attachments) {
      assert.deepEqual(Object.keys(file).sort(), ['filename', 'id', 'mime', 'size', 'url']);
      assert.equal(file.url, `${active.url}/files/${file.id}`);
    }
    const serialized = JSON.stringify(data);
    for (const secret of [other.id, other.content, otherImage.id, h.username, 'password_hash', 'token_hash', 'object_key']) {
      assert.ok(!serialized.includes(secret), `public JSON must omit ${secret}`);
    }
    for (const path of ['/api/notes', `/api/notes/${note.id}`, `/api/notes/${other.id}`, '/api/tags', '/api/stats', '/api/settings']) {
      assert.equal((await h.request(path, anonymous)).status, 401, path);
    }
  });

  await t.test('share attachment URLs authorize only linked ready files, including HEAD and byte ranges', async () => {
    const url = `${active.url}/files/${image.id}`;
    const response = await h.request(url, anonymous);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    privateHeaders(response);
    const head = await h.request(url, { ...anonymous, method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    privateHeaders(head);
    const part = await h.request(url, { ...anonymous, headers: { Range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(2, 6));
    privateHeaders(part);
    assert.equal((await h.request(url, { ...anonymous, headers: { Range: 'bytes=99999-' } })).status, 416);
    assert.equal((await h.request(image.url, anonymous)).status, 401, 'sharing never opens the private file route');
    for (const cookie of ['', h.cookie]) {
      for (const method of ['GET', 'HEAD']) {
        assert.equal((await h.request(`${active.url}/files/${otherImage.id}`, { cookie, method, headers: { Range: 'bytes=0-3' } })).status, 404);
      }
    }
    await h.db.prepare("UPDATE attachments SET status='pending' WHERE id=?").bind(image.id).run();
    try {
      assert.equal((await h.request(url, anonymous)).status, 404);
    } finally {
      await h.db.prepare("UPDATE attachments SET status='ready' WHERE id=?").bind(image.id).run();
    }
  });

  await t.test('active-content attachments download safely and share URLs cannot mutate data', async () => {
    const response = await h.request(`${active.url}/files/${html.id}`, anonymous);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.match(response.headers.get('content-disposition'), /^attachment/);
    privateHeaders(response);
    for (const path of [active.url, active.url + '/note', `${active.url}/files/${image.id}`]) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const result = await h.request(path, { ...anonymous, method, body: { content: 'unauthorized mutation' } });
        assert.ok([404, 405].includes(result.status), `${method} ${path} must reject, got ${result.status}`);
      }
    }
    assert.equal((await (await h.request('/api/notes/' + note.id)).json()).note.content, note.content);
  });

  await t.test('different notes get different tokens and malformed, random or unknown URLs uniformly fail', async () => {
    const second = await share(h, other);
    assert.notEqual(second.url, active.url);
    assert.equal((await (await h.request(second.url + '/note', anonymous)).json()).note.content, other.content);
    assert.equal((await h.request(`${second.url}/files/${image.id}`, anonymous)).status, 404);
    for (const token of ['short', 'g'.repeat(64), randomBytes(32).toString('hex')]) {
      for (const suffix of ['', '/note', `/files/${image.id}`]) {
        const response = await h.request('/s/' + token + suffix, anonymous);
        assert.equal(response.status, 404);
        privateHeaders(response);
      }
    }
    assert.equal((await h.request(active.url + '/comments', anonymous)).status, 404);
  });

  await t.test('saving edits updates the shared note and removing an attachment immediately closes its shared URL', async () => {
    const response = await h.request(`/api/notes/${note.id}`, {
      method: 'PATCH', body: { version: note.version, content: '分享中的最新保存内容 #编辑', attachmentIds: [html.id] },
    });
    assert.equal(response.status, 200);
    note = (await response.json()).note;
    const data = await (await h.request(active.url + '/note', anonymous)).json();
    assert.equal(data.note.content, note.content);
    assert.deepEqual(data.note.attachments.map(file => file.id), [html.id]);
    assert.equal((await h.request(`${active.url}/files/${image.id}`, anonymous)).status, 404);
    assert.equal((await h.request(image.url)).status, 200, 'the private file remains owned and readable');
    assert.deepEqual(await share(h, note), active, 'editing does not renew an existing link');
  });

  await t.test('expiry closes page, metadata and attachment paths without waiting for cleanup; re-share rotates token', async () => {
    await h.db.prepare('UPDATE note_shares SET expires_at=? WHERE note_id=?').bind(Date.now() - 1, note.id).run();
    for (const suffix of ['', '/note', `/files/${html.id}`]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await h.request(active.url + suffix, { ...anonymous, method, headers: { Range: 'bytes=0-3' } });
        assert.equal(response.status, 404, `${method} ${suffix}`);
        privateHeaders(response);
      }
    }
    const old = active;
    const before = Date.now();
    active = await share(h, note);
    const after = Date.now();
    assert.notEqual(active.url, old.url);
    assert.ok(active.expiresAt >= before + DAY && active.expiresAt <= after + DAY);
    assert.deepEqual(await share(h, note), active);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM note_shares WHERE note_id=?').bind(note.id).first()).n, 1);
    for (const suffix of ['', '/note', `/files/${html.id}`]) {
      assert.equal((await h.request(old.url + suffix, anonymous)).status, 404);
      assert.equal((await h.request(active.url + suffix, anonymous)).status, 200);
    }
  });

  await t.test('deleting the note revokes its shared page and files while the other note remains private', async () => {
    const response = await h.request(`/api/notes/${note.id}?version=${note.version}`, { method: 'DELETE' });
    assert.equal(response.status, 204);
    for (const suffix of ['', '/note', `/files/${html.id}`]) {
      assert.equal((await h.request(active.url + suffix, anonymous)).status, 404);
    }
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM note_shares WHERE note_id=?').bind(note.id).first()).n, 0);
    assert.equal((await h.request('/api/notes/' + other.id, anonymous)).status, 401);
    assert.equal((await h.request(otherImage.url, anonymous)).status, 401);
  });
});
