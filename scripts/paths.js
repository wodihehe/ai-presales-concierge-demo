import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root=fileURLToPath(new URL('../',import.meta.url));
const instance=process.env.DEMO_INSTANCE||'local';
if(!/^[a-zA-Z0-9_-]{1,80}$/.test(instance))throw new Error('DEMO_INSTANCE 无效');
export const runtime=path.join(root,'.runtime',instance);
export const csData=path.join(root,'customer-service',instance==='local'?'data':`.runtime/${instance}`);
export const kbRelativeData=instance==='local'?'data':`.runtime/${instance}`;
export const kbData=path.join(root,'knowledge-base',kbRelativeData);
