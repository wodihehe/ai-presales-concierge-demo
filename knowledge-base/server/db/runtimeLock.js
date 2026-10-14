import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
export function acquireRuntimeLock() {
  fs.mkdirSync(CONFIG.DATA_DIR,{recursive:true});
  const file=path.join(CONFIG.DATA_DIR,'.runtime.lock');
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const fd=fs.openSync(file,'wx');
      fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);
      let released=false;
      const release=()=>{if(released)return;released=true;try{if(fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);}catch{}};
      return release;
    }catch(err){
      if(err.code!=='EEXIST')throw err;
      const pid=Number(fs.readFileSync(file,'utf8'));
      try {process.kill(pid,0);}catch(error){if(error.code==='ESRCH'&&Number.isInteger(pid)&&pid>0){fs.unlinkSync(file);continue;}}
      throw new Error('知识库数据目录已被运行中的服务或维护任务占用，请先停止知识库服务');
    }
  }
  throw new Error('无法取得知识库数据目录锁');
}
