import { spawnSync } from 'node:child_process';
import { root } from './seed.js';
import path from 'node:path';
const npm = process.platform==='win32'?'npm.cmd':'npm';
for (const folder of ['customer-service','knowledge-base']) {
  const result=spawnSync(npm,['ci','--no-fund','--no-audit'],{cwd:path.join(root,folder),stdio:'inherit',shell:process.platform==='win32'});
  if(result.status!==0)process.exit(result.status||1);
}
const result=spawnSync(npm,['run','build'],{cwd:path.join(root,'customer-service'),stdio:'inherit',shell:process.platform==='win32'});
process.exit(result.status||0);
