import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { root } from './paths.js';
const require=createRequire(path.join(root,'knowledge-base/package.json'));
const JSZip=require('jszip');
const allowedRoots=['customer-service/server','customer-service/client','customer-service/skills','customer-service/tests','knowledge-base/server','knowledge-base/public','knowledge-base/tests','knowledge-base/vendor','scripts','examples','tests','shared'];
const allowedFiles=['package.json','.gitignore','.env.example','README.md','LICENSE','customer-service/package.json','customer-service/package-lock.json','customer-service/vite.config.js','customer-service/index.html','customer-service/demo-inbox.html','customer-service/demo-inbox.js','knowledge-base/package.json','knowledge-base/package-lock.json'];
const excluded=new Set(['node_modules','data','artifacts','.runtime','.tmp','runtime-temp','.cache','dist','release']);
const fileMap=new Map();
function add(relative){
  const target=path.join(root,relative),stat=fs.lstatSync(target);
  if(stat.isSymbolicLink())throw new Error(`不分发符号链接：${relative}`);
  if(stat.isDirectory()){for(const entry of fs.readdirSync(target))if(!excluded.has(entry))add(`${relative}/${entry}`);return;}
  if(/.(?:db|sqlite)(?:-wal|-shm)?$|\.key$|\.log$/.test(relative))throw new Error(`运行文件不可分发：${relative}`);
  fileMap.set(relative,fs.readFileSync(target));
}
for(const item of [...allowedRoots,...allowedFiles])if(fs.existsSync(path.join(root,item)))add(item);
const rules=[
  ['personal path',/(?:[A-Z]:[\\/](?:Users|aiagent)[\\/])/i],
  ['private key',/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/],
  ['real webhook',/https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]{16,}/],
  ['likely live key',/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/],
];
const hits=[];
for(const [name,buffer] of fileMap){
  if(name.startsWith('knowledge-base/vendor/'))continue;
  for(const [label,pattern] of rules){let content=buffer.toString('utf8');if(label==='real webhook')content=content.replace(/key=synthetic-[a-z-]+/g,'key=demo');if(pattern.test(content))hits.push({file:name,rule:label});}
}
if(hits.length){console.error(JSON.stringify({sensitiveFiles:hits}));process.exit(1);}
const manifest={version:'1.1.0',languages:['zh','en'],generatedAt:new Date().toISOString(),fictionalData:true,modelMode:'offline by default',notifications:'local only',files:[...fileMap].sort(([a],[b])=>a.localeCompare(b)).map(([name,b])=>({name,size:b.length,sha256:createHash('sha256').update(b).digest('hex')}))};
const zip=new JSZip();for(const [name,buffer] of fileMap)zip.file(`ai-concierge-demo/${name}`,buffer);
zip.file('ai-concierge-demo/MANIFEST.json',JSON.stringify(manifest,null,2));
const buffer=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});
const reopened=await JSZip.loadAsync(buffer,{checkCRC32:true});
for(const item of manifest.files){const file=reopened.file(`ai-concierge-demo/${item.name}`);if(!file)throw new Error('ZIP缺文件');const actual=await file.async('nodebuffer');if(createHash('sha256').update(actual).digest('hex')!==item.sha256)throw new Error('ZIP哈希不一致');}
const release=path.join(root,'release');fs.mkdirSync(release,{recursive:true});
const filename='ai-concierge-knowledge-demo-v1.1.0.zip',sha256=createHash('sha256').update(buffer).digest('hex');
fs.writeFileSync(path.join(release,filename),buffer);fs.writeFileSync(path.join(release,`${filename}.sha256`),`${sha256}  ${filename}\n`);
fs.writeFileSync(path.join(release,'manifest.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(release,'validation.json'),JSON.stringify({files:manifest.files.length,zipFiles:Object.keys(reopened.files).length,bytes:buffer.length,sha256,crcAndHashes:'passed',sensitiveRules:rules.map(([r])=>r),sensitiveHits:0,excluded:[...excluded]},null,2));
console.log(JSON.stringify({file:filename,files:manifest.files.length,bytes:buffer.length,sha256,sensitiveHits:0}));
