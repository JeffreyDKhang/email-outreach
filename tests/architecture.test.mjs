import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const app = fileURLToPath(new URL('../app/',import.meta.url));
function files(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry => {
    const path = join(directory,entry.name);
    return entry.isDirectory() ? files(path) : /\.(mts|ts|mjs|js)$/.test(path) && !path.endsWith('.d.ts') ? [path] : [];
  });
}
test('business rules stay independent of UI, storage and browser APIs', async () => {
  for (const path of files(join(app,'domain'))) {
    const source = readFileSync(path,'utf8');
    assert.doesNotMatch(source,/\b(document|localStorage|window)\b/,path);
    for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
      const target = resolve(dirname(path),match[1]);
      assert.ok(target.startsWith(join(app,'domain') + (process.platform === 'win32' ? '\\' : '/')),path);
    }
  }
});
test('UI delegates browser persistence to the storage repository', () => {
  for (const path of [...files(join(app,'ui')),join(app,'app.js')]) {
    assert.doesNotMatch(readFileSync(path,'utf8'),/\blocalStorage\b/,path);
  }
});
test('application workflows do not depend on UI or browser globals', () => {
  for (const path of files(join(app,'application'))) {
    const source=readFileSync(path,'utf8');
    assert.doesNotMatch(source,/\b(document|localStorage|window)\b/,path);
    assert.doesNotMatch(source,/from ['"][^'"]*\/ui\//,path);
  }
});
test('all reusable modules resolve without booting the browser application', async () => {
  for (const path of files(app).filter(path => path !== join(app,'app.js') && path !== join(app,'app.ts'))) {
    await import(pathToFileURL(path).href);
  }
});

test('UI, application and persistence imports respect their dependency boundaries',()=>{
  const allowed={
    ui:['ui','domain','application'],
    application:['application','domain'],
    infrastructure:['infrastructure','domain'],
  };
  for(const [layer,dependencies] of Object.entries(allowed)){
    for(const path of files(join(app,layer))){
      const source=readFileSync(path,'utf8');
      for(const match of source.matchAll(/from ['"]([^'"]+)['"]/g)){
        const target=resolve(dirname(path),match[1]);
        assert.ok(dependencies.some(dependency=>target.startsWith(join(app,dependency)+(process.platform==='win32'?'\\':'/'))),`${path} imports across its boundary: ${match[1]}`);
      }
      if(layer!=='infrastructure')assert.doesNotMatch(source,/\bfetch\s*\(/,`${path} must use the injected API instead of its own transport`);
    }
  }
});

test('server shares pure rules without importing browser presentation or persistence',()=>{
  const server=resolve(app,'../server'),separator=process.platform==='win32'?'\\':'/';
  for(const path of files(server)){
    for(const match of readFileSync(path,'utf8').matchAll(/from ['"]([^'"]+)['"]/g)){
      if(!match[1].startsWith('.'))continue;
      const target=resolve(dirname(path),match[1]);
      assert.ok(target.startsWith(server+separator)||target.startsWith(join(app,'domain')+separator),`${path} imports a browser layer: ${match[1]}`);
    }
  }
});
