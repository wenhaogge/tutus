import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHarness } from './helpers.mjs';
import { verifyBackup } from '../scripts/backup.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const bytes = new TextEncoder().encode('私有附件\nbackup round trip');
function snapshot() {
  const note = randomUUID(), file = randomUUID();
  return {
    manifest: { format: 'qingji-backup', version: 1, createdAt: 1791331200000, credentials: 'preserve-target' },
    tables: {
      owner: [{ display_name: '恢复的名字', settings_json: JSON.stringify({ theme: 'dark' }) }],
      notes: [{ id: note, content: `# 中文恢复\n[附件](/files/${file}) #生活`, tags_json: '["生活"]', created_at: 1700000000000, updated_at: 1710000000000, archived_at: 1710000000001, pinned: 1, version: 7 }],
      attachments: [{ id: file, filename: '私密.txt', mime: 'text/plain', size: bytes.length, sha256: hash(bytes), status: 'ready', created_at: 1700000000001 }],
      note_attachments: [{ note_id: note, attachment_id: file }],
    },
  };
}
async function seed(h, data) {
  const n = data.tables.notes[0], f = data.tables.attachments[0];
  await h.db.batch([
    h.db.prepare('UPDATE owner SET display_name=?,settings_json=? WHERE id=1').bind(data.tables.owner[0].display_name, data.tables.owner[0].settings_json),
    h.db.prepare('INSERT INTO notes(id,content,tags_json,created_at,updated_at,archived_at,pinned,version) VALUES(?,?,?,?,?,?,?,?)').bind(n.id, n.content, n.tags_json, n.created_at, n.updated_at, n.archived_at, n.pinned, n.version),
    h.db.prepare('INSERT INTO attachments(id,object_key,filename,mime,size,sha256,status,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(f.id, `original/${f.id}`, f.filename, f.mime, f.size, f.sha256, f.status, f.created_at),
    h.db.prepare('INSERT INTO note_attachments(note_id,attachment_id) VALUES(?,?)').bind(n.id, f.id),
  ]);
  await h.bucket.put(`original/${f.id}`, bytes);
}
const post = (h, path, body) => h.request('/api/backup' + path, { method: 'POST', body });
async function login(h) {
  const response = await h.request('/api/auth/login', { method: 'POST', body: { username: h.username, password: h.password } });
  assert.equal(response.status, 200);
  h.cookie = response.headers.get('set-cookie').split(';')[0];
}

test('backup round trip preserves all note fields, private files and settings, but keeps target password and revokes sessions', async () => {
  const source = await createHarness(), target = await createHarness();
  try {
    await source.setup(); await target.setup();
    const original = snapshot();
    await seed(source, original);
    const shareResponse = await source.request(`/api/notes/${original.tables.notes[0].id}/share`, { method: 'POST', body: {} });
    assert.equal(shareResponse.ok, true);
    const shared = (await shareResponse.json()).share;
    const start = await post(source, '/start', {});
    assert.equal(start.status, 200);
    const exported = await start.json();
    assert.equal('password_hash' in exported.tables.owner[0], false);
    assert.equal('object_key' in exported.tables.attachments[0], false);
    assert.equal('note_shares' in exported.tables, false, 'temporary sharing capabilities are not backed up');
    assert.equal(JSON.stringify(exported).includes(shared.url.split('/').pop()), false);
    assert.deepEqual(exported.tables.notes, original.tables.notes);
    assert.equal((await source.request('/api/notes', { method: 'POST', body: { content: '冻结时不能写' } })).status, 503);
    await assert.rejects(source.db.prepare('UPDATE notes SET content=?').bind('race').run(), /maintenance/);
    assert.equal((await source.request('/files/' + original.tables.attachments[0].id)).status, 200);
    assert.equal((await post(source, '/finish', { token: exported.token })).status, 200);
    const imported = { manifest: exported.manifest, tables: exported.tables };
    const targetPassword = (await target.db.prepare('SELECT password_hash FROM owner').first()).password_hash;
    const begin = await post(target, '/restore/start', imported);
    assert.equal(begin.status, 200);
    const { token } = await begin.json();
    assert.equal((await post(target, '/restore/commit', { token })).status, 409);
    assert.equal((await target.request('/api/backup/restore/files/' + original.tables.attachments[0].id, { method: 'PUT', headers: { 'X-Backup-Token': token }, body: new Uint8Array([1, 2]) })).status, 400);
    const upload = () => target.request('/api/backup/restore/files/' + original.tables.attachments[0].id, { method: 'PUT', headers: { 'X-Backup-Token': token }, body: bytes });
    assert.equal((await upload()).status, 200);
    assert.equal((await upload()).status, 200, 'upload retry is safe');
    assert.equal((await post(target, '/restore/commit', { token })).status, 200);
    assert.equal((await target.request('/api/notes')).status, 401, 'restore revokes the current session');
    assert.equal((await target.db.prepare('SELECT password_hash FROM owner').first()).password_hash, targetPassword);
    assert.deepEqual((await target.db.prepare('SELECT * FROM notes').all()).results, original.tables.notes);
    assert.deepEqual((await target.db.prepare('SELECT * FROM note_attachments').all()).results, original.tables.note_attachments);
    assert.equal((await target.db.prepare('SELECT display_name FROM owner').first()).display_name, '恢复的名字');
    const stored = await target.db.prepare('SELECT object_key FROM attachments').first();
    assert.deepEqual(new Uint8Array(await (await target.bucket.get(stored.object_key)).arrayBuffer()), bytes);
    await login(target);
    assert.equal((await target.request('/files/' + original.tables.attachments[0].id)).status, 200);
    assert.equal((await target.request('/files/' + original.tables.attachments[0].id, { cookie: '' })).status, 401);
    assert.equal((await target.request(shared.url + '/note', { cookie: '' })).status, 404, 'restoring a backup does not revive public links');
    assert.equal((await target.db.prepare('SELECT count(*) AS n FROM note_shares').first()).n, 0);
  } finally { await source.close(); await target.close(); }
});

test('restore rejects nonempty targets and invalid manifests; wrong tokens cannot release a lock', async () => {
  const h = await createHarness();
  try {
    await h.setup();
    const data = snapshot();
    const invalid = structuredClone(data); invalid.tables.note_attachments[0].note_id = randomUUID();
    assert.equal((await post(h, '/restore/start', invalid)).status, 400);
    assert.equal((await h.db.prepare('SELECT maintenance FROM app_state').first()).maintenance, 0);
    const start = await post(h, '/restore/start', data);
    assert.equal(start.status, 200);
    const { token } = await start.json();
    assert.equal((await post(h, '/release', { token: 'restore:' + randomUUID() })).status, 409);
    assert.equal((await h.db.prepare('SELECT maintenance FROM app_state').first()).maintenance, 1);
    assert.equal((await post(h, '/release', { token })).status, 200);
    await seed(h, data);
    assert.equal((await post(h, '/restore/start', data)).status, 409);
    assert.equal((await h.db.prepare('SELECT content FROM notes').first()).content, data.tables.notes[0].content);
  } finally { await h.close(); }
});

test('export refuses unsettled attachments; release recovers interrupted restore and removes staging objects', async () => {
  const h = await createHarness();
  try {
    await h.setup();
    const data = snapshot(), file = data.tables.attachments[0];
    await h.db.prepare("INSERT INTO attachments(id,object_key,filename,mime,size,sha256,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)").bind(file.id, 'pending/test', file.filename, file.mime, file.size, file.sha256, file.created_at).run();
    assert.equal((await post(h, '/start', {})).status, 409);
    assert.equal((await h.db.prepare('SELECT maintenance FROM app_state').first()).maintenance, 0);
    await h.db.prepare('DELETE FROM attachments').run();
    const { token } = await (await post(h, '/restore/start', data)).json();
    assert.equal((await h.request('/api/backup/restore/files/' + file.id, { method: 'PUT', headers: { 'X-Backup-Token': token }, body: bytes })).status, 200);
    const status = await (await h.request('/api/backup/status')).json();
    assert.equal(status.token, token);
    assert.equal((await post(h, '/release', { token })).status, 200);
    assert.equal((await h.bucket.list()).objects.length, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS total FROM notes').first()).total, 0);
    assert.equal((await h.db.prepare('SELECT maintenance FROM app_state').first()).maintenance, 0);
    assert.equal((await post(h, '/restore/commit', { token })).status, 409);
  } finally { await h.close(); }
});

test('restore database failure rolls back unlock, profile changes and inserts; it remains recoverable', async () => {
  const h = await createHarness();
  try {
    await h.setup();
    const data = snapshot(), file = data.tables.attachments[0];
    const originalName = (await h.db.prepare('SELECT display_name FROM owner').first()).display_name;
    await h.db.prepare("CREATE TRIGGER simulate_restore_failure BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END").run();
    const { token } = await (await post(h, '/restore/start', data)).json();
    assert.equal((await h.request('/api/backup/restore/files/' + file.id, { method: 'PUT', headers: { 'X-Backup-Token': token }, body: bytes })).status, 200);
    assert.equal((await post(h, '/restore/commit', { token })).status, 500);
    assert.equal((await h.db.prepare('SELECT maintenance FROM app_state').first()).maintenance, 1);
    assert.equal((await h.db.prepare('SELECT display_name FROM owner').first()).display_name, originalName);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM notes').first()).n, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM attachments').first()).n, 0);
    assert.equal((await h.request('/api/backup/status')).status, 200, 'failed restore retains the session');
    assert.equal((await post(h, '/release', { token })).status, 200);
    assert.equal((await h.bucket.list()).objects.length, 0);
  } finally { await h.close(); }
});

test('backup metadata, controls and restore uploads all require authentication', async () => {
  const h = await createHarness();
  try {
    await h.setup();
    for (const [path, method] of [['/status', 'GET'], ['/start', 'POST'], ['/finish', 'POST'], ['/release', 'POST'], ['/restore/start', 'POST'], ['/restore/commit', 'POST'], ['/restore/files/' + randomUUID(), 'PUT']]) {
      assert.equal((await h.request('/api/backup' + path, { method, cookie: '', ...(method !== 'GET' ? { body: {} } : {}) })).status, 401, path);
    }
  } finally { await h.close(); }
});

test('offline backup verification detects changed metadata, corrupt/missing files and traversal IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qingji-backup-test-'));
  try {
    const data = snapshot(), file = data.tables.attachments[0];
    await mkdir(join(directory, 'files'));
    const saveManifest = async value => {
      const text = JSON.stringify(value);
      await writeFile(join(directory, 'manifest.json'), text);
      await writeFile(join(directory, 'manifest.sha256'), hash(text));
    };
    await saveManifest(data);
    await writeFile(join(directory, 'COMPLETE'), 'complete');
    await writeFile(join(directory, 'files', file.id), bytes);
    assert.deepEqual(await verifyBackup(directory), data);
    await writeFile(join(directory, 'manifest.json'), (await readFile(join(directory, 'manifest.json'), 'utf8')) + ' ');
    await assert.rejects(verifyBackup(directory), /清单校验失败/);
    await saveManifest(data);
    const corrupted = Uint8Array.from(bytes); corrupted[0] ^= 1;
    await writeFile(join(directory, 'files', file.id), corrupted);
    await assert.rejects(verifyBackup(directory), /SHA-256/);
    await rm(join(directory, 'files', file.id));
    await assert.rejects(verifyBackup(directory), /ENOENT/);
    data.tables.attachments[0].id = '../outside';
    await saveManifest(data);
    await assert.rejects(verifyBackup(directory), /附件清单无效/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the actual CLI exports, verifies and restores over HTTP to an independent empty application', async () => {
  const source = await createHarness(), target = await createHarness();
  const parent = await mkdtemp(join(tmpdir(), 'qingji-cli-backup-test-'));
  try {
    await source.setup(); await target.setup();
    const data = snapshot(); await seed(source, data);
    const destination = join(parent, 'backup');
    const cli = async (h, args) => execute(process.execPath, ['scripts/backup.mjs', ...args], { env: { ...process.env, QINGJI_URL: (await h.mf.ready).origin, QINGJI_USERNAME: h.username, QINGJI_PASSWORD: h.password }, timeout: 25000 });
    const exported = await cli(source, ['export', '--out', destination]);
    assert.match(exported.stdout, /备份及离线校验完成/);
    const verified = await cli(source, ['verify', '--from', destination]);
    assert.match(verified.stdout, /离线校验通过/);
    const restored = await cli(target, ['restore', '--from', destination]);
    assert.match(restored.stdout, /恢复完成/);
    assert.deepEqual((await target.db.prepare('SELECT * FROM notes').all()).results, data.tables.notes);
    const stored = await target.db.prepare('SELECT object_key FROM attachments').first();
    assert.deepEqual(new Uint8Array(await (await target.bucket.get(stored.object_key)).arrayBuffer()), bytes);
    assert.equal((await source.db.prepare('SELECT maintenance FROM app_state').first()).maintenance, 0);
    assert.equal((await target.db.prepare('SELECT maintenance FROM app_state').first()).maintenance, 0);
    await assert.rejects(cli(source, ['export', '--out', destination]), /EEXIST/);
  } finally { await source.close(); await target.close(); await rm(parent, { recursive: true, force: true }); }
});
