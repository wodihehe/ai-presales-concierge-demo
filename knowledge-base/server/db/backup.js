import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from '../config.js';
import { getDatabase, db, closeDatabase } from './index.js';
import { acquireRuntimeLock } from './runtimeLock.js';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inside(root,file){const relative=path.relative(root,path.resolve(file));if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('维护路径必须位于知识库目录内部');return path.resolve(file);}
function safeFilename(value){if(typeof value!=='string'||!value||path.basename(value)!==value||/[\\/:]/.test(value))throw new Error('附件存储名不合法');return value;}

export function createBackup() {
  // CLI takes the same lock as startServer. Calls within the single running
  // process are synchronous, so neither DB nor files can mutate during snapshot.
  const release=db?()=>{}:acquireRuntimeLock();
  try{
    const database=getDatabase();
    const timestamp=new Date().toISOString().replace(/[:.]/g,'-');
    const temp=path.join(CONFIG.BACKUP_DIR,`.pending-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(temp,'uploads'),{recursive:true});
    const target=path.join(temp,'knowledge_base.db');
    database.exec(`VACUUM INTO '${target.replace(/'/g,"''")}';`);
    const snapshot=new DatabaseSync(target,{readOnly:true});
    let files;try{files=snapshot.prepare('SELECT DISTINCT stored_filename FROM project_files').all();if(snapshot.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('备份数据库校验失败');}finally{snapshot.close();}
    const hashes={};
    for(const file of files){const name=safeFilename(file.stored_filename);const src=path.join(CONFIG.UPLOAD_DIR,name);if(!fs.existsSync(src))throw new Error('引用附件缺失，备份未完成');fs.copyFileSync(src,path.join(temp,'uploads',name));hashes[name]=hash(src);}
    const manifest={format:2,timestamp,dbSha256:hash(target),dbSize:fs.statSync(target).size,fileCount:files.length,files:hashes};
    fs.writeFileSync(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2));
    const backupFolder=path.join(CONFIG.BACKUP_DIR,`backup_${timestamp}_${crypto.randomBytes(3).toString('hex')}`);
    fs.renameSync(temp,backupFolder);
    return {...manifest,backupFolder};
  }finally{release();}
}

export function restoreBackup(backupFolder) {
  if(db)throw new Error('请关闭数据库连接并停止知识库服务后恢复');
  const release=acquireRuntimeLock();
  try{
    backupFolder=inside(CONFIG.ROOT_DIR,backupFolder);
    const manifest=JSON.parse(fs.readFileSync(path.join(backupFolder,'manifest.json'),'utf8'));
    if(manifest.format!==2||!manifest.files||typeof manifest.files!=='object')throw new Error('仅支持经校验的format=2备份；旧备份请人工迁移');
    const sourceDb=path.join(backupFolder,'knowledge_base.db');
    if(hash(sourceDb)!==manifest.dbSha256)throw new Error('备份数据库校验和不匹配，未修改现有数据');
    const verify=new DatabaseSync(sourceDb,{readOnly:true});
    let files;
    try{if(verify.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||verify.prepare('PRAGMA foreign_key_check').all().length)throw new Error('备份数据库完整性校验失败');files=verify.prepare('SELECT DISTINCT stored_filename FROM project_files').all().map(f=>safeFilename(f.stored_filename));}finally{verify.close();}
    if(files.length!==manifest.fileCount)throw new Error('备份附件数量不匹配');
    for(const name of files)if(hash(path.join(backupFolder,'uploads',name))!==manifest.files[name])throw new Error('备份附件校验失败，未修改现有数据');
    const work=path.join(CONFIG.DATA_DIR,`restore-${crypto.randomUUID()}`),staged=path.join(work,'staged'),previous=path.join(work,'previous');
    fs.mkdirSync(path.join(staged,'uploads'),{recursive:true});fs.mkdirSync(previous);
    fs.copyFileSync(sourceDb,path.join(staged,'knowledge_base.db'));
    for(const name of files)fs.copyFileSync(path.join(backupFolder,'uploads',name),path.join(staged,'uploads',name));
    const moved=[];let installedDb=false,installedUploads=false;
    try{
      for(const name of ['knowledge_base.db','knowledge_base.db-wal','knowledge_base.db-shm','uploads','.setup_token']){
        const old=path.join(CONFIG.DATA_DIR,name);if(fs.existsSync(old)){fs.renameSync(old,path.join(previous,name));moved.push(name);}
      }
      fs.renameSync(path.join(staged,'knowledge_base.db'),CONFIG.DB_PATH);installedDb=true;
      fs.renameSync(path.join(staged,'uploads'),CONFIG.UPLOAD_DIR);installedUploads=true;
    }catch(err){
      if(installedUploads)fs.renameSync(CONFIG.UPLOAD_DIR,path.join(staged,'uploads'));
      if(installedDb)fs.renameSync(CONFIG.DB_PATH,path.join(staged,'knowledge_base.db'));
      for(const name of moved.reverse())fs.renameSync(path.join(previous,name),path.join(CONFIG.DATA_DIR,name));
      throw err;
    }
    return {success:true,previousData:previous,fileCount:files.length};
  }finally{release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=process.argv[2]==='restore'?restoreBackup(process.argv[3]):createBackup();console.log(JSON.stringify(result,null,2));closeDatabase();}catch(err){console.error(err.message);closeDatabase();process.exitCode=1;}
}
