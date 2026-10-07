// Only the isolated synthetic browser fixture on port8788. Never a user instance.
import {readFile,writeFile,unlink} from 'node:fs/promises';
const origin='http://127.0.0.1:8788';const path='test-results/browser-lock.json';
async function call(route,body,cookie=''){const res=await fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});if(!res.ok)throw new Error(await res.text());return res;}
if(process.argv[2]==='start'){
 const login=await call('/api/auth/login',{username:'owner',password:'Correct-horse-1234'}),cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
 const result=await(await call('/api/backup/start',{},cookie)).json();await writeFile(path,JSON.stringify({cookie,token:result.token}),{mode:0o600});console.log('Isolated browser fixture maintenance started.');
}else if(process.argv[2]==='stop'){
 const data=JSON.parse(await readFile(path,'utf8'));await call('/api/backup/finish',{token:data.token},data.cookie);await call('/api/auth/logout',{},data.cookie);await unlink(path);console.log('Isolated browser fixture maintenance stopped.');
}else throw new Error('start or stop required');
