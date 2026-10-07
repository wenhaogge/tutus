import { build } from 'esbuild';
await build({entryPoints:['src/worker/index.ts'],outfile:'dist/worker.js',bundle:true,format:'esm',target:'es2022',platform:'browser',sourcemap:true});
console.log('Worker built: dist/worker.js');
