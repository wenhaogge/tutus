import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createHarness } from './helpers.mjs';

test('scheduled cleanup preserves maintenance and recent/ready files while removing stale pending and deleting files', async () => {
  const h = await createHarness();
  try {
    const now = Date.now();
    const make = (status, ageHours) => {
      const id = randomUUID();
      const bytes = new TextEncoder().encode(`private ${status} ${id}`);
      return { id, key: `files/${id}/${randomUUID()}`, status, createdAt: now - ageHours * 3600_000, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
    };
    const recent = make('pending', 1);
    const stale = make('pending', 25);
    const deleting = make('deleting', 1);
    const ready = make('ready', 48);
    const files = [recent, stale, deleting, ready];
    for (const file of files) {
      await h.db.prepare('INSERT INTO attachments(id,object_key,filename,mime,size,sha256,status,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(file.id, file.key, 'private.txt', 'text/plain', file.bytes.length, file.hash, file.status, file.createdAt).run();
      await h.bucket.put(file.key, file.bytes);
    }
    const readRows = async () => (await h.db.prepare('SELECT * FROM attachments ORDER BY id').all()).results;
    const before = await readRows();
    const worker = await h.mf.getWorker();
    await h.db.prepare('UPDATE app_state SET maintenance=1,maintenance_token=?,maintenance_started_at=? WHERE id=1').bind('export:' + randomUUID(), now).run();
    const paused = await worker.scheduled({ scheduledTime: new Date(), cron: '17 3 * * *' });
    assert.equal(paused.outcome, 'ok');
    assert.deepEqual(await readRows(), before, 'maintenance prevents all attachment changes');
    for (const file of files) assert.deepEqual(new Uint8Array(await (await h.bucket.get(file.key)).arrayBuffer()), file.bytes, 'maintenance preserves actual private object bytes');

    await h.db.prepare('UPDATE app_state SET maintenance=0,maintenance_token=NULL,maintenance_started_at=NULL WHERE id=1').run();
    const completed = await worker.scheduled({ scheduledTime: new Date(), cron: '17 3 * * *' });
    assert.equal(completed.outcome, 'ok');
    const remaining = await readRows();
    assert.deepEqual(remaining.map(row => row.id).sort(), [recent.id, ready.id].sort());
    assert.equal(remaining.find(row => row.id === recent.id).status, 'pending');
    assert.equal(remaining.find(row => row.id === ready.id).status, 'ready');
    for (const file of [stale, deleting]) assert.equal(await h.bucket.get(file.key), null, 'cleanup deletes the immutable object key stored in D1');
    for (const file of [recent, ready]) assert.deepEqual(new Uint8Array(await (await h.bucket.get(file.key)).arrayBuffer()), file.bytes, 'recent pending and ready objects survive');
  } finally { await h.close(); }
});
