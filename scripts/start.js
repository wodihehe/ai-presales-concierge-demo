import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { root, seed } from './seed.js';
import { kbRelativeData } from './paths.js';
if (!process.env.DEMO_INSTANCE && existsSync(path.join(root,'.env'))) process.loadEnvFile(path.join(root,'.env'));
const csPort=Number(process.env.DEMO_CS_PORT||3318),kbPort=Number(process.env.DEMO_KB_PORT||3320);
if (![csPort,kbPort].every(p=>Number.isInteger(p)&&p>1024&&p<=65535)||csPort===kbPort) throw new Error('演示端口无效或重复');
for (const port of [csPort,kbPort]) await new Promise((resolve,reject)=>{
  const probe=net.createServer();probe.once('error',()=>reject(new Error(`演示端口 ${port} 已占用，未启动或修改已有服务`)));
  probe.listen(port,'127.0.0.1',()=>probe.close(resolve));
});
if(!existsSync(path.join(root,'customer-service/dist/index.html')))throw new Error('请先执行 npm run setup 安装依赖并构建');
await seed();
const children=[];let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');process.exitCode=code;}
for(const [folder,port,entry] of [['knowledge-base',kbPort,'server/demo.js'],['customer-service',csPort,'server/demo.js']]){
  const child=spawn(process.execPath,[entry],{cwd:path.join(root,folder),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),KB_DATA_DIR:kbRelativeData,DEMO_KB_PORT:String(kbPort),NODE_ENV:'development'},stdio:'inherit',windowsHide:true});
  children.push(child);child.once('exit',code=>{if(!stopping)stop(code||1);});
}
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>stop());
console.log(`\n客服 Demo：http://127.0.0.1:${csPort}\n知识库：http://127.0.0.1:${kbPort}\n登录可用页面上的“演示后台”入口。虚构案例价格，本地通知。`);
