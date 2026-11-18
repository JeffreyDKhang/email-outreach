import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Compile before loading the backend. Outputs stay beside their sources so
// existing browser URLs, tests, launcher and .local paths remain compatible.
const root=fileURLToPath(new URL('../',import.meta.url));
const compiler=fileURLToPath(new URL('../node_modules/typescript/bin/tsc',import.meta.url));
if(!existsSync(compiler)){
  console.error('Run npm ci in email-outreach before starting the app.');
  process.exit(1);
}
const result=spawnSync(process.execPath,[compiler,'-p','tsconfig.build.json'],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
await import('../server/main.mjs');
