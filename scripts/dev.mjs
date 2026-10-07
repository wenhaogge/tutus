import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { readFile,writeFile,mkdir,stat } from 'node:fs/promises';
import { resolve,extname,sep } from 'node:path';
import { randomBytes } from 'node:crypto';

await mkdir('.local',{recursive:true});
let secret;
try{secret=(await readFile('.local/setup-secret.txt','utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;secret=randomBytes(24).toString('hex');await writeFile('.local/setup-secret.txt',secret,{mode:0o600,flag:'wx'});}
await viteBuild();
await build({entryPoints:['src/worker/index.ts'],outfile:'dist/worker.js',bundle:true,format:'esm',target:'es2022',platform:'browser',sourcemap:true});
const root=resolve('dist/client');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json'};
const mf=new Miniflare({host:'127.0.0.1',port:Number(process.env.PORT??8787),modules:true,scriptPath:resolve('dist/worker.js'),compatibilityDate:'2026-07-30',d1Databases:['DB'],d1Persist:resolve('.local/d1'),r2Buckets:['FILES'],r2Persist:resolve('.local/r2'),bindings:{SETUP_SECRET:secret},serviceBindings:{ASSETS:async req=>{
  let pathname;try{pathname=decodeURIComponent(new URL(req.url).pathname);}catch{return new Response('Bad path',{status:400});}
  let file=resolve(root,'.'+pathname);if(file!==root&&!file.startsWith(root+sep))return new Response('Not found',{status:404});
  try{if(!(await stat(file)).isFile())file=resolve(root,'index.html');}catch{file=resolve(root,'index.html');}
  return new Response(await readFile(file),{headers:{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-cache'}});
}}});
const db=await mf.getD1Database('DB');
// Idempotent CREATE/INSERT OR IGNORE only: existing local notes and files are never reset.
const schema=await readFile('schema.sql','utf8');
try { await db.batch(schema.split('-- statement-break').map(s=>s.replace(/^\s*--.*$/gm,'').trim()).filter(Boolean).map(s=>db.prepare(s))); } catch(e) { await mf.dispose();throw e; }
// Miniflare does not run configured cron triggers automatically.
const worker=await mf.getWorker();
let cleanupRun;
function runCleanup(){
  if(cleanupRun)return cleanupRun;
  cleanupRun=(async()=>{
    try{
      const result=await worker.scheduled({scheduledTime:new Date(),cron:'17 3 * * *'});
      if(result.outcome!=='ok')console.error('本地残留清理未完成：',result.outcome);
    }catch(error){console.error('本地残留清理失败，稍后会重试：',error);}
    finally{cleanupRun=undefined;}
  })();
  return cleanupRun;
}
await runCleanup();
const cleanupTimer=setInterval(()=>void runCleanup(),3600_000);
cleanupTimer.unref();
console.log(`\nTutus已启动：${await mf.ready}\n首次建立账号时，从 .local/setup-secret.txt 复制初始化密钥。\n这是本地数据，保存在 .local/，重启不会清空。Ctrl+C 停止。\n`);
const stop=async()=>{clearInterval(cleanupTimer);await cleanupRun;await mf.dispose();process.exit(0);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
