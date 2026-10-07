import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function createHarness(options={}) {
  const mf = new Miniflare({modules:true,scriptPath:resolve('dist/worker.js'),compatibilityDate:'2026-07-30',d1Databases:['DB'],r2Buckets:['FILES'],bindings:{SETUP_SECRET:'test-setup-secret-not-production-123'},serviceBindings:{ASSETS:()=>new Response('<html>Qingji</html>',{headers:{'Content-Type':'text/html'}})},...options});
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('FILES');
  const schema=await readFile('schema.sql','utf8');
  const statements=schema.split('-- statement-break').map(s=>s.replace(/^\s*--.*$/gm,'').trim()).filter(Boolean);
  try { await db.batch(statements.map(s=>db.prepare(s))); } catch(e) { await mf.dispose(); throw e; }
  const h={mf,db,bucket,username:'owner',password:'Correct-horse-1234',setupSecret:'test-setup-secret-not-production-123',cookie:'',
    async request(path,opts={}) {
      const headers=new Headers(opts.headers);
      if(opts.origin!==false && !headers.has('Origin')) headers.set('Origin','http://localhost');
      const cookie=opts.cookie??h.cookie; if(cookie)headers.set('Cookie',cookie);
      let body=opts.body;
      if(body!==undefined && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && typeof body!=='string') {body=JSON.stringify(body);if(!headers.has('Content-Type'))headers.set('Content-Type','application/json');}
      return mf.dispatchFetch('http://localhost'+path,{method:opts.method??'GET',headers,body});
    },
    async setup() {const res=await h.request('/api/auth/setup',{method:'POST',cookie:'',body:{setupSecret:h.setupSecret,username:h.username,password:h.password,displayName:'测试笔记'}});h.cookie=res.headers.get('set-cookie')?.split(';')[0]??'';return res;},
    async close(){await mf.dispose();}
  }; return h;
}
