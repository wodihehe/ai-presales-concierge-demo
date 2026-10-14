import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CONFIG } from '../server/config.js';
import { initDatabase,closeDatabase,getDatabase } from '../server/db/index.js';
import { createApp } from '../server/index.js';
import { createSessionToken,isInitialized,getOrCreateSetupToken } from '../server/middleware/auth.js';
import { createBackup,restoreBackup } from '../server/db/backup.js';
import { acquireRuntimeLock } from '../server/db/runtimeLock.js';
import { ModelClient } from '../server/services/modelClient.js';
import { extractDocumentText } from '../server/services/fileParser.js';
import { saveDraft } from '../server/services/draftStore.js';
import { TaskQueue } from '../server/services/taskQueue.js';
import { withStagedFiles } from '../server/services/fileRemoval.js';
import { startMockModel } from './helpers/mockModel.js';

test('实际HTTP、持久文件与恢复回归 [SYNTHETIC_FIXTURE]',async t=>{
  let db=initDatabase();
  const mock=await startMockModel();
  const server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await mock.close();closeDatabase();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const users=['owner','other','admin'].map(id=>({id,role:id==='admin'?'admin':'staff',username:id,token_version:1}));
  for(const u of users)db.prepare("INSERT INTO users VALUES(?,?,'','',?,?,0,1,datetime('now'),datetime('now'))").run(u.id,u.id,u.role,u.id);
  const tokens=Object.fromEntries(users.map(u=>[u.id,createSessionToken(u)]));
  const set=(k,v)=>db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?,datetime('now'))").run(k,v);
  set('model_base_url',mock.url);set('model_name','synthetic-mock');set('model_api_key',crypto.randomBytes(24).toString('hex'));set('integration_api_key',crypto.randomBytes(24).toString('hex'));
  async function api(route,{method='GET',body,user='owner',form}={}){
    const r=await fetch(base+route,{method,headers:{Authorization:`Bearer ${tokens[user]}`,...(body?{'Content-Type':'application/json'}:{})},body:form|| (body?JSON.stringify(body):undefined)});
    return {status:r.status,data:await r.json()};
  }
  let id,quoteFile;
  const snapshot=()=>db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  await t.test('实际多文件上传→HTTP模型→聊天→员工审核→外部查询→撤回',async()=>{
    const created=await api('/api/projects',{method:'POST',body:{title:'[SYNTHETIC_FIXTURE] 工单',category:'工作流搭建'}});id=created.data.project.id;
    const form=new FormData();form.append('files',new Blob(['[SYNTHETIC_FIXTURE] 按目标、功能、交付边界组织方案。自动创建工单与发送处理通知。']),'最终方案.txt');form.append('files',new Blob(['[SYNTHETIC_FIXTURE] 一期最终报价人民币12000元']),'最终报价.txt');
    const upload=await api(`/api/projects/${id}/files`,{method:'POST',form});assert.equal(upload.status,200);assert.ok(upload.data.files.every(f=>f.parse_status==='parsed'));assert.equal(upload.data.files[1].original_name,'最终报价.txt');quoteFile=upload.data.files[1].id;
    const extracted=await api(`/api/projects/${id}/organize/extract`,{method:'POST'});assert.equal(extracted.data.success,true);
    const phase=db.prepare('SELECT * FROM project_phases WHERE project_id=?').get(id);assert.equal(phase.source_file_id,quoteFile);assert.equal(phase.allow_cs_quote,0,'模型不能开启报价许可');
    const chat=await api(`/api/projects/${id}/organize/chat`,{method:'POST',body:{message:'[SYNTHETIC_FIXTURE] 交付物补充测试培训手册',clientDraftVersion:snapshot().draft_version}});assert.equal(chat.data.patchApplied,true);assert.match(snapshot().deliverables,/测试培训手册/);
    const quoteRequest=async()=>{const r=await fetch(base+'/api/integrations/customer-service/search',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${db.prepare("SELECT value FROM settings WHERE key='integration_api_key'").get().value}`},body:JSON.stringify({query:'一期工单工作流自动创建工单发送处理通知',profile:{features:['自动创建工单','发送处理通知']}})});return r.json();};
    assert.deepEqual((await quoteRequest()).cases,[]);
    assert.equal((await api(`/api/projects/${id}/draft`,{method:'PUT',body:{clientDraftVersion:snapshot().draft_version,phases:[{id:phase.id,allow_cs_quote:true}]}})).status,200);
    assert.equal((await api(`/api/projects/${id}/review/submit`,{method:'POST'})).status,200);
    assert.equal((await api(`/api/projects/${id}/review/approve`,{method:'POST',user:'other',body:{clientDraftVersion:snapshot().draft_version}})).status,200);
    const cases=(await quoteRequest()).cases;assert.equal(cases[0].price.min,12000);assert.equal(cases[0].match,true);assert.ok(!JSON.stringify(cases).includes('raw_amount_text'));
    assert.equal((await api(`/api/projects/${id}/review/revoke`,{method:'POST',user:'other',body:{reason:'合成回归撤回'}})).status,200);assert.deepEqual((await quoteRequest()).cases,[]);
  });
  await t.test('金额无来源拒绝、未知币种保留、来源不能串项目',()=>{
    assert.throws(()=>saveDraft(id,'owner',{phases:[{amount_min:100,amount_max:100}]},snapshot().draft_version,{model:true}),e=>e.code==='invalid_source');
    assert.throws(()=>saveDraft(id,'owner',{phases:[{source_file_id:'another-project-file'}]},snapshot().draft_version),e=>e.code==='invalid_source');
    const version=snapshot().draft_version;
    saveDraft(id,'owner',{phases:[{phase_name:'未知关系',scope_description:'测试范围',amount_min:100,amount_max:100}]},version);
    const p=db.prepare('SELECT * FROM project_phases WHERE project_id=?').get(id);assert.equal(p.currency,'');assert.equal(p.relation,'unknown');
  });
  await t.test('视觉确实发送图片；未配置与异常输出诚实失败',async()=>{
    const filename=path.join(CONFIG.DATA_DIR,'synthetic.png');fs.writeFileSync(filename,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKtwAAAAASUVORK5CYII=','base64'));
    let parsed=await extractDocumentText(filename,'synthetic.png','image/png');assert.equal(parsed.parse_status,'image_stored_no_vision');
    set('model_supports_vision','true');parsed=await extractDocumentText(filename,'synthetic.png','image/png');assert.equal(parsed.parse_status,'parsed');assert.match(mock.requests.at(-1).messages.at(-1).content[1].image_url.url,/^data:image\/png;base64,/);
    mock.setMode('invalid');parsed=await extractDocumentText(filename,'synthetic.png','image/png');assert.equal(parsed.parse_status,'failed');mock.setMode('normal');
  });
  await t.test('响应正文超时、429、非法JSON与截断不会回显上游正文',async()=>{
    for(const [mode,reason] of [['rate','rate_limited'],['invalid','invalid_json'],['truncated','truncated'],['slow','timeout']]){
      mock.setMode(mode);const start=Date.now();const result=await ModelClient.chatCompletion({messages:[{role:'user',content:'test'}],timeoutMs:100});assert.equal(result.reason,reason);assert.ok(!JSON.stringify(result).includes('SYNTHETIC_UPSTREAM_SECRET'));assert.ok(Date.now()-start<2000);
    }mock.setMode('normal');
    const connected=await api('/api/settings/test-model',{user:'admin',method:'POST',body:{model_api_key:''}});assert.equal(connected.data.success,true);
  });
  await t.test('处理中任务禁止删附件；失败后重解析与来源失效',async()=>{
    const task=TaskQueue.createTask(id,'file_parse');TaskQueue.startTask(task.id);
    assert.equal((await api(`/api/projects/${id}/files/${quoteFile}`,{method:'DELETE'})).status,409);
    assert.equal((await api(`/api/projects/${id}/files/${quoteFile}/reparse`,{method:'POST'})).status,409);
    TaskQueue.failTask(task.id,'合成中断');assert.equal((await api(`/api/projects/${id}/files/${quoteFile}/reparse`,{method:'POST'})).data.success,true);
    const p=db.prepare('SELECT * FROM project_phases WHERE project_id=?').get(id);db.prepare('UPDATE project_phases SET source_file_id=?,allow_cs_quote=1 WHERE id=?').run(quoteFile,p.id);
    assert.equal((await api(`/api/projects/${id}/files/${quoteFile}`,{method:'DELETE'})).status,200);assert.equal(db.prepare('SELECT allow_cs_quote FROM project_phases WHERE id=?').get(p.id).allow_cs_quote,0);
  });
  await t.test('文件暂存遇数据库失败恢复原件',()=>{
    const name='rollback-synthetic.txt',file=path.join(CONFIG.UPLOAD_DIR,name);fs.writeFileSync(file,'[SYNTHETIC_FIXTURE] preserve');
    assert.throws(()=>withStagedFiles([name],()=>{throw new Error('synthetic transaction failure');}));assert.equal(fs.readFileSync(file,'utf8'),'[SYNTHETIC_FIXTURE] preserve');fs.unlinkSync(file);
  });
  await t.test('初始化锁不会因管理员停用重新开放；会话权限立即失效',async()=>{
    db.prepare("UPDATE users SET disabled=1 WHERE id='admin'").run();assert.equal(isInitialized(),true);assert.equal(getOrCreateSetupToken(),null);assert.equal((await api('/api/settings',{user:'admin'})).status,401);db.prepare("UPDATE users SET disabled=0 WHERE id='admin'").run();
    db.prepare("UPDATE users SET token_version=2 WHERE id='other'").run();assert.equal((await api('/api/projects',{user:'other'})).status,401);
  });
  await t.test('运行锁、真实WAL备份恢复、旧WAL隔离及损坏备份拒绝',()=>{
    db.prepare('UPDATE projects SET overview=? WHERE id=?').run('[SYNTHETIC_FIXTURE] WAL快照',id);
    const backup=createBackup();const files=db.prepare('SELECT stored_filename,sha256 FROM project_files').all();assert.ok(files.length>0);
    db.prepare('UPDATE projects SET overview=? WHERE id=?').run('快照后内容',id);closeDatabase();
    const release=acquireRuntimeLock();assert.throws(()=>restoreBackup(backup.backupFolder),/占用/);release();
    fs.writeFileSync(CONFIG.DB_PATH+'-wal','synthetic stale WAL');fs.writeFileSync(CONFIG.DB_PATH+'-shm','synthetic stale SHM');
    const restored=restoreBackup(backup.backupFolder);assert.equal(restored.success,true);assert.ok(fs.existsSync(path.join(restored.previousData,'knowledge_base.db-wal')));assert.ok(!fs.existsSync(CONFIG.DB_PATH+'-wal'));
    db=initDatabase();assert.equal(snapshot().overview,'[SYNTHETIC_FIXTURE] WAL快照');for(const f of files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(CONFIG.UPLOAD_DIR,f.stored_filename))).digest('hex'),f.sha256);
    closeDatabase();const before=crypto.createHash('sha256').update(fs.readFileSync(CONFIG.DB_PATH)).digest('hex');fs.appendFileSync(path.join(backup.backupFolder,'knowledge_base.db'),'corruption');assert.throws(()=>restoreBackup(backup.backupFolder),/校验和/);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(CONFIG.DB_PATH)).digest('hex'),before);db=initDatabase();
  });
  await t.test('真实新进程打开后中断任务与pending附件可恢复',()=>{
    const task=TaskQueue.createTask(id,'ai_organize');TaskQueue.startTask(task.id);db.prepare("UPDATE project_files SET parse_status='pending' WHERE project_id=?").run(id);closeDatabase();
    const script="import {initDatabase,closeDatabase} from './server/db/index.js';const db=initDatabase(undefined,{recoverTasks:true});console.log(JSON.stringify({tasks:db.prepare(\"SELECT COUNT(*) n FROM tasks WHERE status IN ('pending','running')\").get().n,files:db.prepare(\"SELECT COUNT(*) n FROM project_files WHERE parse_status='pending'\").get().n}));closeDatabase();";
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:CONFIG.ROOT_DIR,env:{...process.env,KB_DATA_DIR:CONFIG.DATA_DIR},encoding:'utf8',windowsHide:true});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{tasks:0,files:0});db=initDatabase();assert.equal(TaskQueue.getTask(task.id).status,'interrupted');assert.ok(db.prepare('SELECT COUNT(*) n FROM project_chat WHERE project_id=?').get(id).n>=3);
  });
  await t.test('永久删除清理实际原件与关联记录；其他员工拒绝',async()=>{
    assert.equal((await api(`/api/projects/${id}`,{method:'DELETE'})).status,403);const files=db.prepare('SELECT stored_filename FROM project_files WHERE project_id=?').all(id);
    const result=await api(`/api/projects/${id}`,{method:'DELETE',user:'admin'});assert.equal(result.data.deleted,true);assert.equal(result.data.cleanupPending,false);assert.equal(snapshot(),undefined);for(const f of files)assert.ok(!fs.existsSync(path.join(CONFIG.UPLOAD_DIR,f.stored_filename)));
  });
});
