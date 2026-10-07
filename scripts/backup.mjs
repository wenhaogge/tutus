#!/usr/bin/env node
/** Offline-verifiable, private directory backups. No account/session credentials are exported. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, realpath, rename, rm } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_METADATA = 8 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function equalHash(a, b) { return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
function fileRows(snapshot) {
  if (snapshot?.manifest?.format !== 'qingji-backup' || snapshot.manifest.version !== 1 || snapshot.manifest.credentials !== 'preserve-target' || !Array.isArray(snapshot.tables?.attachments) || !Array.isArray(snapshot.tables?.notes) || !Array.isArray(snapshot.tables?.note_attachments) || !Array.isArray(snapshot.tables?.owner)) throw new Error('不支持的备份格式');
  const ids = new Set();
  for (const file of snapshot.tables.attachments) {
    if (!UUID.test(file.id) || ids.has(file.id) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('附件清单无效');
    ids.add(file.id);
  }
  return snapshot.tables.attachments;
}
async function safeRegularFile(root, relativePath) {
  const filename = join(root, relativePath);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('备份不能包含符号链接或特殊文件');
  const actual = await realpath(filename);
  if (!actual.startsWith((await realpath(root)) + sep)) throw new Error('备份文件路径越界');
  return { filename, size: info.size };
}
export async function hashFile(filename) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}
/** Runs completely offline; restore calls this before sending any target mutation. */
export async function verifyBackup(directory) {
  const root = resolve(directory);
  const manifestFile = await safeRegularFile(root, 'manifest.json');
  if (manifestFile.size > MAX_METADATA) throw new Error('备份元数据超过 8 MiB');
  const checksumFile = await safeRegularFile(root, 'manifest.sha256');
  if (checksumFile.size > 100) throw new Error('清单校验文件无效');
  await safeRegularFile(root, 'COMPLETE');
  const bytes = await readFile(manifestFile.filename);
  const expected = (await readFile(checksumFile.filename, 'utf8')).trim();
  if (!equalHash(digest(bytes), expected)) throw new Error('备份清单校验失败');
  const snapshot = JSON.parse(bytes.toString('utf8'));
  const filesDirectory = await lstat(join(root, 'files'));
  if (!filesDirectory.isDirectory() || filesDirectory.isSymbolicLink()) throw new Error('附件目录无效');
  for (const file of fileRows(snapshot)) {
    const local = await safeRegularFile(root, join('files', file.id));
    if (local.size !== file.size) throw new Error(`附件大小校验失败：${file.id}`);
    const actual = await hashFile(local.filename);
    if (!equalHash(actual.sha256, file.sha256)) throw new Error(`附件 SHA-256 校验失败：${file.id}`);
  }
  return snapshot;
}
function options(argv) {
  const [command, ...args] = argv;
  const parsed = { command };
  for (let index = 0; index < args.length; index += 2) {
    if (!['--url', '--username', '--out', '--from'].includes(args[index]) || !args[index + 1]) throw new Error('参数无效，请运行 help 查看用法');
    parsed[args[index].slice(2)] = args[index + 1];
  }
  return parsed;
}
async function prompt(label, hidden = false) {
  if (!process.stdin.isTTY) throw new Error(`非交互运行请通过环境变量提供 ${hidden ? 'QINGJI_PASSWORD' : 'QINGJI_USERNAME'}`);
  if (!hidden) {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try { return await reader.question(label); } finally { reader.close(); }
  }
  process.stdout.write(label);
  return await new Promise((resolvePassword, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => { process.stdin.setRawMode(Boolean(wasRaw)); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') { cleanup(); reject(new Error('已取消')); return; }
        if (character === '\r' || character === '\n') { cleanup(); resolvePassword(value); return; }
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ') value += character;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
}
async function client(opts) {
  const url = new URL(opts.url || process.env.QINGJI_URL || 'http://localhost:8787');
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('远程应用必须使用 HTTPS，URL 不得包含账号密码');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('--url 只填写应用来源，例如 https://notes.example.com');
  const username = opts.username || process.env.QINGJI_USERNAME || await prompt('用户名：');
  const password = process.env.QINGJI_PASSWORD || await prompt('密码（不显示）：', true);
  let cookie = '';
  async function request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('Origin', url.origin);
    if (cookie) headers.set('Cookie', cookie);
    const response = await fetch(url.origin + path, { ...init, headers, redirect: 'error' });
    if (!response.ok) {
      let message;
      try { message = (await response.json()).error?.message; } catch { /* A proxy may return HTML. */ }
      throw new Error(message || `请求失败 HTTP ${response.status}`);
    }
    return response;
  }
  async function json(path, body) {
    const response = await request(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await response.json();
  }
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('登录未返回会话');
  return { request, json, logout: () => json('/api/auth/logout', {}) };
}
async function download(client, file, directory) {
  const response = await client.request(`/files/${file.id}`);
  if (!response.body) throw new Error(`附件没有返回内容：${file.id}`);
  const temporary = join(directory, file.id + '.part');
  const hash = createHash('sha256');
  let size = 0;
  const checking = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > file.size || size > MAX_FILE) callback(new Error('下载附件超过清单声明大小'));
    else { hash.update(chunk); callback(null, chunk); }
  } });
  await pipeline(Readable.fromWeb(response.body), checking, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
  if (size !== file.size || !equalHash(hash.digest('hex'), file.sha256)) throw new Error(`下载附件校验失败：${file.id}`);
  await rename(temporary, join(directory, file.id));
}
export async function run(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (!opts.command || opts.command === 'help') {
    console.log(`Tutus备份工具（Node.js 22+）
  node scripts/backup.mjs export  --url URL --out 全新的备份目录 [--username 用户名]
  node scripts/backup.mjs verify  --from 备份目录
  node scripts/backup.mjs restore --url URL --from 备份目录 [--username 用户名]
  node scripts/backup.mjs status  --url URL
  node scripts/backup.mjs release --url URL

密码交互输入且不显示，或使用 QINGJI_PASSWORD；不要把密码放在命令行。
export 在下载期间暂停写入；异常后用 status/release 解除维护状态。
restore 仅允许空目标，保留目标登录账号和密码，完成后使所有会话失效。
备份是明文个人数据（不含密码哈希、会话和部署密钥）。使用私有目录及加密磁盘，保留独立副本。
release 会取消尚未提交的恢复并删除暂存附件；不会删除已提交的数据。`);
    return;
  }
  if (!['export', 'verify', 'restore', 'status', 'release'].includes(opts.command)) throw new Error('未知命令');
  if (['verify', 'restore'].includes(opts.command) && !opts.from) throw new Error('必须指定 --from');
  // All source files are checked before login or acquiring a target restore lock.
  const snapshot = ['verify', 'restore'].includes(opts.command) ? await verifyBackup(opts.from) : null;
  if (opts.command === 'verify') { console.log(`离线校验通过：${snapshot.tables.notes.length} 条笔记，${snapshot.tables.attachments.length} 个附件。`); return; }
  if (opts.command === 'export' && !opts.out) throw new Error('必须指定 --out，且目录不能已存在');
  const api = await client(opts);
  let lock;
  let committed = false;
  try {
    if (opts.command === 'status' || opts.command === 'release') {
      const state = await api.json('/api/backup/status');
      if (opts.command === 'status') console.log(JSON.stringify(state, null, 2));
      else if (state.token) { await api.json('/api/backup/release', { token: state.token }); console.log('维护状态已解除。'); }
      else console.log('当前没有维护操作。');
      return;
    }
    if (opts.command === 'export') {
      const directory = resolve(opts.out);
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 }); // EEXIST deliberately refuses overwrites.
      await mkdir(join(directory, 'files'), { mode: 0o700 });
      const result = await api.json('/api/backup/start', {});
      lock = result.token;
      const data = { manifest: result.manifest, tables: result.tables };
      await writeFile(join(directory, 'maintenance-token.json'), JSON.stringify({ token: lock }), { flag: 'wx', mode: 0o600 });
      // Canonical compact metadata is the server limit; whitespace is omitted on disk as well.
      const compact = JSON.stringify(data);
      await writeFile(join(directory, 'manifest.json'), compact, { flag: 'wx', mode: 0o600 });
      await writeFile(join(directory, 'manifest.sha256'), digest(compact) + '\n', { flag: 'wx', mode: 0o600 });
      for (const file of fileRows(data)) await download(api, file, join(directory, 'files'));
      await api.json('/api/backup/finish', { token: lock });
      lock = null;
      await writeFile(join(directory, 'COMPLETE'), 'qingji-backup-v1\n', { flag: 'wx', mode: 0o600 });
      await rm(join(directory, 'maintenance-token.json'));
      await verifyBackup(directory);
      console.log(`备份及离线校验完成：${directory}\n${data.tables.notes.length} 条笔记，${data.tables.attachments.length} 个附件。文件为明文，请妥善保管。`);
    } else {
      const result = await api.json('/api/backup/restore/start', snapshot);
      lock = result.token;
      for (const file of fileRows(snapshot)) {
        const bytes = await readFile(join(resolve(opts.from), 'files', file.id));
        // Recheck immediately before sending in case the source changed after preflight.
        if (bytes.length !== file.size || !equalHash(digest(bytes), file.sha256)) throw new Error('本地附件在校验后发生变化，恢复已停止');
        await api.request(`/api/backup/restore/files/${file.id}`, { method: 'PUT', headers: { 'X-Backup-Token': lock, 'Content-Type': 'application/octet-stream' }, body: bytes });
      }
      const resultCommit = await api.json('/api/backup/restore/commit', { token: lock });
      committed = true; lock = null;
      console.log(`恢复完成：${resultCommit.notes} 条笔记，${resultCommit.attachments} 个附件。请使用目标原有账号密码重新登录，并抽查笔记和图片。`);
    }
  } finally {
    if (lock) {
      try { await api.json('/api/backup/release', { token: lock }); }
      catch { console.error('未能确认维护状态。请重新登录运行 status；若仍在维护，运行 release。若提交响应丢失，请先查看目标数据，勿清空目标重试。'); }
    }
    if (!committed) try { await api.logout(); } catch { /* Original result takes priority. */ }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(error => { console.error(`失败：${error.message}`); process.exitCode = 1; });
}
