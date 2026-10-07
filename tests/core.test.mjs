import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir,mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness } from './helpers.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8sAAAAASUVORK5CYII=','base64');
const upload=(h,id=randomUUID(),bytes=png,name='日常.png',mime='image/png')=>h.request('/api/attachments',{method:'POST',body:bytes,headers:{'Content-Type':mime,'X-Filename':encodeURIComponent(name),'X-Upload-Id':id}});

test('core notes, private attachments, safe failures and personal search',async t=>{
 const h=await createHarness();t.after(()=>h.close());assert.equal((await h.setup()).status,201);
 let file,note;
 await t.test('private upload is idempotent; distinct bytes cannot overwrite',async()=>{
  const id=randomUUID(),res=await upload(h,id);assert.equal(res.status,201,await res.clone().text());file=(await res.json()).attachment;
  assert.equal(file.filename,'日常.png');assert.equal((await upload(h,id)).status,200);
  assert.equal((await upload(h,id,Buffer.from('different'))).status,409);
  assert.equal((await h.db.prepare('SELECT count(*) n FROM attachments').first()).n,1);
 });
 await t.test('unauthenticated or forged cookie cannot read private files',async()=>{
  assert.equal((await h.request(file.url,{cookie:''})).status,401);
  assert.equal((await h.request(file.url,{cookie:'qingji_session=forged'})).status,401);
  const res=await h.request(file.url);assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),png);
  assert.match(res.headers.get('cache-control'),/no-store/);assert.equal(res.headers.get('x-content-type-options'),'nosniff');
  const head=await h.request(file.url,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  const part=await h.request(file.url,{headers:{Range:'bytes=1-4'}});assert.equal(part.status,206);assert.deepEqual(Buffer.from(await part.arrayBuffer()),png.subarray(1,5));
  const invalid=await h.request(file.url,{headers:{Range:'bytes=99999-'}});assert.equal(invalid.status,416);
 });
 await t.test('create retrieves Markdown, Chinese tags and image relationship',async()=>{
  const id=randomUUID(),content=`今天的灵感 #生活 #想法\n\nHello 100%_done\n![日常](${file.url})\n\n\`#不是标签\``;
  const res=await h.request('/api/notes',{method:'POST',body:{id,content,attachmentIds:[file.id]}});assert.equal(res.status,201,await res.clone().text());note=(await res.json()).note;
  assert.deepEqual(note.tags,['生活','想法']);assert.equal(note.attachments[0].id,file.id);
  assert.equal((await h.request('/api/notes',{method:'POST',body:{id,content,attachmentIds:[file.id]}})).status,200);
  const second=(await (await upload(h)).json()).attachment;
  assert.equal((await h.request('/api/notes',{method:'POST',body:{id,content,attachmentIds:[file.id,second.id]}})).status,409);
  assert.equal((await h.request('/api/attachments/'+file.id,{method:'DELETE'})).status,409);
 });
 await t.test('keyword is literal, Chinese works, invalid filters fail explicitly',async()=>{
  for(const q of ['灵感','hello','100%_done']){const result=await(await h.request('/api/notes?q='+encodeURIComponent(q))).json();assert.equal(result.total,1);}
  assert.equal((await(await h.request('/api/notes?q='+encodeURIComponent('100%_missing'))).json()).total,0);
  assert.equal((await h.request('/api/notes?filter=unsupported')).status,400);
  assert.equal((await h.request('/api/notes?archived=anything')).status,400);
  const long='很长的关键词'.repeat(10);assert.equal((await h.request('/api/notes?q='+encodeURIComponent(long))).status,200);
  const tag=await(await h.request('/api/notes?tag='+encodeURIComponent('生活'))).json();assert.equal(tag.total,1);
  const tags=await(await h.request('/api/tags')).json();assert.ok(tags.tags.some(t=>t.name==='生活'&&t.count===1));
 });
 await t.test('optimistic edit, concurrent conflict and bad fields cannot overwrite',async()=>{
  const oldVersion=note.version;
  const [a,b]=await Promise.all(['A','B'].map(value=>h.request('/api/notes/'+note.id,{method:'PATCH',body:{version:oldVersion,content:`${value} #生活`,attachmentIds:[file.id]}})));
  assert.deepEqual([a.status,b.status].sort(),[200,409]);note=(await(a.status===200?a:b).json()).note;
  const before=note.content;
  assert.equal((await h.request('/api/notes/'+note.id,{method:'PATCH',body:{version:note.version,spaces:['unused']}})).status,400);
  assert.equal((await(await h.request('/api/notes/'+note.id)).json()).note.content,before);
 });
 await t.test('pin, archive, restore, date and calendar counts are correct',async()=>{
  note=(await(await h.request('/api/notes/'+note.id,{method:'PATCH',body:{version:note.version,pinned:true,archived:true}})).json()).note;
  assert.equal(note.pinned,true);assert.equal(note.archived,true);
  assert.equal((await(await h.request('/api/notes')).json()).total,0);assert.equal((await(await h.request('/api/notes?archived=1')).json()).total,1);
  note=(await(await h.request('/api/notes/'+note.id,{method:'PATCH',body:{version:note.version,archived:false}})).json()).note;
  const date=Date.UTC(2026,0,1,20,0,0);await h.db.prepare('UPDATE notes SET created_at=? WHERE id=?').bind(date,note.id).run();
  const stats=await(await h.request('/api/stats?tzOffset=480')).json();assert.ok(stats.days.some(d=>d.day==='2026-01-02'&&d.count===1));
  assert.equal((await(await h.request(`/api/notes?from=${date}&to=${date+1}`)).json()).total,1);
  assert.equal((await(await h.request(`/api/notes?from=${date+1}`)).json()).total,0);
 });
 await t.test('settings persist and unsupported input is rejected',async()=>{
  const res=await h.request('/api/settings',{method:'PATCH',body:{theme:'dark',displayName:'自己的笔记'}});assert.equal(res.status,200);
  assert.equal((await(await h.request('/api/settings')).json()).settings.displayName,'自己的笔记');
  assert.equal((await h.request('/api/settings',{method:'PATCH',body:{public:true}})).status,400);
  assert.equal((await h.request('/api/spaces')).status,404);
 });
 await t.test('active content files download and overlimit body fails before storage',async()=>{
  const res=await upload(h,randomUUID(),Buffer.from('<script>alert(1)</script>'),'example.html','text/html');assert.equal(res.status,201);
  const url=(await res.json()).attachment.url,read=await h.request(url);assert.match(read.headers.get('content-disposition'),/^attachment/);assert.equal(read.headers.get('content-type'),'application/octet-stream');
  assert.equal((await upload(h,randomUUID(),new Uint8Array(10*1024*1024+1),'large.bin','application/octet-stream')).status,413);
 });
 await t.test('R2-success D1-pending upload can be retried safely',async()=>{
  const id=randomUUID(),hash=createHash('sha256').update(png).digest('hex');
  await h.db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,'pending',?)").bind(id,'files/'+id+'/'+hash,'日常.png','image/png',png.length,hash,Date.now()).run();
  await h.bucket.put('files/'+id+'/'+hash,png);
  const res=await upload(h,id);assert.equal(res.status,201);assert.equal((await h.db.prepare('SELECT status FROM attachments WHERE id=?').bind(id).first()).status,'ready');
 });
 await t.test('missing R2 object reports failure rather than false success',async()=>{
  const res=await upload(h),f=(await res.json()).attachment;await h.bucket.delete((await h.db.prepare('SELECT object_key FROM attachments WHERE id=?').bind(f.id).first()).object_key);
  assert.equal((await h.request(f.url)).status,503);
  await h.request('/api/attachments/'+f.id,{method:'DELETE'});
 });
 await t.test('delete respects version and retains file until explicit orphan cleanup',async()=>{
  assert.equal((await h.request(`/api/notes/${note.id}?version=999`,{method:'DELETE'})).status,409);
  assert.equal((await h.request(`/api/notes/${note.id}?version=${note.version}`,{method:'DELETE'})).status,204);
  assert.equal((await h.request(file.url)).status,200);
  assert.equal((await h.request('/api/attachments/'+file.id,{method:'DELETE'})).status,204);
  assert.equal((await h.request(file.url)).status,404);
 });
});

test('fresh worker process preserves existing D1, session and private R2 bytes',async()=>{
 await mkdir('test-results',{recursive:true});const dir=resolve(await mkdtemp('test-results/persistence-'));
 const options={d1Persist:resolve(dir,'d1'),r2Persist:resolve(dir,'r2')};let h=await createHarness(options);let cookie,noteId,file;
 try{await h.setup();cookie=h.cookie;file=(await(await upload(h)).json()).attachment;const res=await h.request('/api/notes',{method:'POST',body:{content:'重启之后也在 #持久化',attachmentIds:[file.id]}});noteId=(await res.json()).note.id;}finally{await h.close();}
 h=await createHarness(options);h.cookie=cookie;try{assert.equal((await h.request('/api/auth/status')).status,200);assert.equal((await(await h.request('/api/notes/'+noteId)).json()).note.content,'重启之后也在 #持久化');assert.deepEqual(Buffer.from(await(await h.request(file.url)).arrayBuffer()),png);}finally{await h.close();}
});
