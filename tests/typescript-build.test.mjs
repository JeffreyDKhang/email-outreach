import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
function files(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(directory,entry.name)):[join(directory,entry.name)]);}
test('every runtime module has TypeScript source and a compatible built JavaScript path',()=>{
  for(const path of [...files(join(root,'app')),...files(join(root,'server'))]){
    if(/\.(mjs|js)$/.test(path))assert.ok(existsSync(path.replace(/\.mjs$/,'.mts').replace(/\.js$/,'.ts')),`Unmigrated runtime module: ${path}`);
    if(/\.(mts|ts)$/.test(path)&&!path.endsWith('.d.ts'))assert.ok(existsSync(path.replace(/\.mts$/,'.mjs').replace(/\.ts$/,'.js')),`Missing build output: ${path}`);
  }
});
test('typed static DOM IDs describe the actual HTML and dialog markup',()=>{
  const declarations=readFileSync(join(root,'app/ui/elements.d.ts'),'utf8');
  const ids=new Map([...declarations.matchAll(/"([\w-]+)": "([\w-]+)"/g)].map(([,id,tag])=>[id,tag]));
  const source=[join(root,'app/index.html'),join(root,'app/app.ts'),...files(join(root,'app/ui')).filter(path=>path.endsWith('.mts'))].map(path=>readFileSync(path,'utf8')).join('\n');
  for(const [,tag,id] of source.matchAll(/<([a-z][a-z0-9-]*)\b[^<>]*?\bid=["']([a-zA-Z][a-zA-Z0-9-]*)["']/g))assert.equal(ids.get(id),tag,`Wrong or missing DOM type for ${id}`);
});
