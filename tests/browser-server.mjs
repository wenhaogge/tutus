import { createHarness } from './helpers.mjs';
import { readFile,stat,writeFile,mkdir } from 'node:fs/promises';
import { resolve,extname,sep } from 'node:path';
const root=resolve('dist/client');
const h=await createHarness({host:'127.0.0.1',port:8788,serviceBindings:{ASSETS:async req=>{
 let file=resolve(root,'.'+new URL(req.url).pathname);if(file!==root&&!file.startsWith(root+sep))return new Response('',{status:404});
 try{if(!(await stat(file)).isFile())file=resolve(root,'index.html');}catch{file=resolve(root,'index.html');}
 return new Response(await readFile(file),{headers:{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream'}});
}}});
const setup=await h.setup();if(setup.status!==201)throw new Error(await setup.text());
await mkdir('test-results',{recursive:true});
await writeFile('test-results/image-fixture.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8sAAAAASUVORK5CYII=','base64'));
await h.mf.ready;
// Cookies are scoped to hosts, not ports. Use localhost for tests so the
// production-local app at 127.0.0.1 keeps its own login cookie.
console.log('Isolated browser test app: http://localhost:8788/ (use localhost, not 127.0.0.1); test credentials are fixtures in tests/helpers.mjs. No production data.');
process.on('SIGINT',async()=>{await h.close();process.exit(0);});
