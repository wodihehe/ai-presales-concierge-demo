import { rmSync } from 'node:fs';
import path from 'node:path';
import { root } from './paths.js';
// Only disposable caches inside this demo copy. Never target business data or a parent checkout.
for(const relative of ['knowledge-base/tests/.tmp','knowledge-base/tests/runtime-temp','customer-service/知识库/tests/.tmp']){
  const target=path.resolve(root,relative),under=path.relative(root,target);
  if(!under||under.startsWith('..')||path.isAbsolute(under))throw new Error('清理路径越界');
  rmSync(target,{recursive:true,force:true});
}
console.log('Demo 测试缓存已清理；运行数据未操作。');
