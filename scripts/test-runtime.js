import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { root } from './paths.js';
export async function runtime({csPort=3418,kbPort=3420}={}){
  mkdirSync(path.join(root,'.runtime'),{recursive:true});
  const dir=mkdtempSync(path.join(root,'.runtime/test-')),instance=path.basename(dir);
  const env={...process.env,DEMO_INSTANCE:instance,DEMO_CS_PORT:String(csPort),DEMO_KB_PORT:String(kbPort),DEMO_MODEL_BASE_URL:'',DEMO_MODEL_NAME:'',DEMO_MODEL_API_KEY:''};
  let child,output='';
  const launch=()=>{child=spawn(process.execPath,['scripts/start.js'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);};
  launch();
  const cs=`http://127.0.0.1:${csPort}`,kb=`http://127.0.0.1:${kbPort}`;
  let stopCalled=false;
  const halt=async()=>{
    if(process.platform==='win32')await new Promise(resolve=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('exit',resolve);});
    else{child.kill('SIGTERM');await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,2000);});}
  };
  const stop=async()=>{
    if(stopCalled)return;stopCalled=true;await halt();
    for(const target of [dir,path.join(root,'customer-service/.runtime',instance),path.join(root,'knowledge-base/.runtime',instance)]){
      const relative=path.relative(root,target);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('测试清理路径越界');
      rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
    }
  };
  const ready=async()=>{
    const end=Date.now()+20000;
    while(Date.now()<end){
      if(child.exitCode!==null)throw new Error(`测试服务提前退出：${output}`);
      try{const a=await fetch(`${cs}/api/health`),b=await fetch(`${kb}/api/auth/status`);if(a.ok&&b.ok)return;}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error(`测试服务未就绪：${output}`);
  };
  try{await ready();return {cs,kb,stop,dir,restart:async()=>{await halt();launch();await ready();}};}
  catch(error){await stop();throw error;}
}
export function client(base,locale){
  const cookies=new Map();
  if(locale)cookies.set('demo_locale',locale);
  return async function call(route,{method='GET',body,raw,headers={},status=200}={}){
    const response=await fetch(base+route,{method,redirect:'manual',headers:{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):raw});
    for(const cookie of response.headers.getSetCookie()){const [k,v]=cookie.split(';')[0].split('=');cookies.set(k,v);}
    if(response.status!==status)throw new Error(`${method} ${route}: ${response.status} expected ${status}; ${await response.text()}`);
    return response.headers.get('content-type')?.includes('application/json')?response.json():response.text();
  };
}
