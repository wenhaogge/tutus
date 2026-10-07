import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/worker.js';
import { createHarness } from './helpers.mjs';

// Exercise the actual bundled HTTP handler against real local D1. The one read
// interception models a request suspended while restore commits and revokes all
// sessions. It does not replace D1's writes, transaction handling, or constraints.
for (const method of ['PATCH', 'DELETE']) {
  test(`in-flight ${method} cannot overwrite data restored after its authentication check`, async (t) => {
    const h = await createHarness();
    t.after(() => h.close());
    assert.equal((await h.setup()).status, 201);
    const created = await h.request('/api/notes', { method: 'POST', body: { content: '原来的笔记' } });
    assert.equal(created.status, 201);
    const { note } = await created.json();
    const restoredText = '已从独立备份恢复，必须保留';
    let intercepted = false;

    const database = new Proxy(h.db, {
      get(target, property) {
        if (property !== 'prepare') {
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql) => {
          const original = target.prepare(sql);
          const isPreWriteRead = method === 'PATCH'
            ? sql === 'SELECT * FROM notes WHERE id=?'
            : sql === 'SELECT version FROM notes WHERE id=?';
          if (!isPreWriteRead || intercepted) return original;
          return {
            bind(...parameters) {
              const statement = original.bind(...parameters);
              return {
                async first(...args) {
                  const beforeRestore = await statement.first(...args);
                  intercepted = true;
                  // Restore intentionally keeps stable IDs and note versions.
                  await target.batch([
                    target.prepare('UPDATE notes SET content=?,version=? WHERE id=?').bind(restoredText, note.version, note.id),
                    target.prepare('DELETE FROM sessions'),
                  ]);
                  return beforeRestore;
                },
              };
            },
          };
        };
      },
    });

    const url = `http://localhost/api/notes/${note.id}${method === 'DELETE' ? '?version=' + note.version : ''}`;
    const request = new Request(url, {
      method,
      headers: { Origin: 'http://localhost', Cookie: h.cookie, 'Content-Type': 'application/json' },
      ...(method === 'PATCH' ? { body: JSON.stringify({ version: note.version, content: '过期请求不能写入' }) } : {}),
    });
    const response = await worker.fetch(request, {
      DB: database, FILES: h.bucket, SETUP_SECRET: h.setupSecret,
      ASSETS: { fetch: () => new Response('') },
    }, { waitUntil() {}, passThroughOnException() {} });
    assert.ok(intercepted, 'the session must be revoked after auth and the old-note read');
    assert.ok(response.status >= 400 && response.status < 600, 'the suspended write must fail');
    const preserved = await h.db.prepare('SELECT content,version FROM notes WHERE id=?').bind(note.id).first();
    assert.deepEqual(preserved, { content: restoredText, version: note.version });
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM sessions').first()).n, 0);
  });
}
