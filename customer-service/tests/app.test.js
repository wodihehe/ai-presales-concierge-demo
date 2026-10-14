import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {openStore,RETENTION_MS} from '../server/store.js';
import {createApp} from '../server/app.js';
import {queueLead,messageParts} from '../server/notifications.js';

const profile={project:'企业文档问答项目',scenario:'员工查资料',problem:'查找文档慢',features:['文档检索','问答'],inputs:'PDF',outputs:'有出处的回答',integrations:'暂无',budget:'不确定',timeline:'不确定'};
const password='local-test-password-123';
const setup=(t,options={})=>{const dir=mkdtempSync(path.join(os.tmpdir(),'concierge-test-')),store=openStore(dir);const {app,tick}=createApp(store,{rateLimits:false,...options});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,app,tick,dir};};
const json=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
async function session(agent){return json(await agent.get('/api/session')).conversation;}
async function login(agent){return json(await agent.post('/api/admin/login').send({username:'admin',password}));}

test('anonymous resumes its conversation while other visitors cannot read or mutate it',async t=>{
  const {app}=setup(t),a=request.agent(app),b=request.agent(app);const c=await session(a);
  assert.equal((await session(a)).id,c.id);assert.notEqual((await session(b)).id,c.id);
  assert.equal((await b.get(`/api/conversations/${c.id}`)).status,404);
  assert.equal((await b.post(`/api/conversations/${c.id}/contact`).send({email:'x@example.com',consent:true,project:'项目测试'})).status,404);
  const next=json(await a.post('/api/conversations')).conversation;assert.notEqual(next.id,c.id);assert.equal((await session(a)).id,next.id);
});
test('new consultation isolates full project state while preserving the old records and original expiry',async t=>{
  const modelCalls=[];
  const {app,store,dir}=setup(t,{replyFn:async input=>{
    modelCalls.push(structuredClone(input));
    if(input.conversationState.quote){const latest=input.messages.at(-1);return {profile:input.profile,ready:true,degraded:false,reply:'',action:{type:'quote_feedback',summaryVersion:input.conversationState.summaryVersion,quoteVersion:input.conversationState.quote.version,sourceMessageId:latest.id,evidence:latest.content,scopeChanged:false,feedback:'too_high'}};}
    return {profile:{...input.profile,project:'新的工作流项目'},ready:false,degraded:false,reply:'收到新项目啦，请说说希望自动化哪一步？'};
  }});
  const owner=request.agent(app),other=request.agent(app);
  const old=store.getConversation((await session(owner)).id);
  const createdAt=Date.now()-5*24*60*60*1000;
  Object.assign(old,{
    createdAt:new Date(createdAt).toISOString(),expiresAt:new Date(createdAt+RETENTION_MS).toISOString(),
    profile:structuredClone(profile),summaryReady:true,summaryConfirmed:true,summaryVersion:4,
    quote:{min:1000,max:2000,currency:'CNY',version:4},quoteSources:['synthetic-old-case'],knowledgeStatus:'quoted',
    feedback:'accepted',handoff:true,followupStatus:'following',
    contact:{email:'old-consultation@example.test',consent:true,name:'测试访客',company:'合成测试公司'},
    requestIds:['old-message-request'],notificationReason:'旧项目需要人工确认'
  });
  old.messages[0].createdAt=old.createdAt;
  const attachment={id:'old-project-file',conversationId:old.id,name:'old-project.txt',mime:'text/plain',size:16,
    status:'parsed',kind:'document',text:'old project file',createdAt:old.createdAt};
  const filePath=path.join(dir,'files',attachment.id);
  writeFileSync(filePath,attachment.text);
  store.saveAttachment(attachment);
  old.messages.push({id:'old-user-message',role:'user',content:'旧项目需求已确认并接受参考报价',createdAt:old.createdAt,
    attachments:[{id:attachment.id,name:attachment.name,url:`/api/files/${attachment.id}`}]});
  store.db.prepare('UPDATE conversations SET data=?,created_at=?,expires_at=? WHERE id=?')
    .run(JSON.stringify(old),createdAt,createdAt+RETENTION_MS,old.id);
  assert.equal(queueLead(store,old),true);
  const oldRecord=store.db.prepare('SELECT * FROM conversations WHERE id=?').get(old.id);
  const oldNotifications=store.notifications(old.id);
  const oldPublic=json(await owner.get(`/api/conversations/${old.id}`)).conversation;

  const fresh=json(await owner.post('/api/conversations')).conversation;
  assert.notEqual(fresh.id,old.id);
  const emptyProfile={project:'',scenario:'',problem:'',features:[],inputs:'',outputs:'',integrations:'',budget:'',timeline:''};
  assert.deepEqual(fresh.profile,emptyProfile);
  assert.equal(fresh.summaryReady,false);assert.equal(fresh.summaryConfirmed,false);assert.equal(fresh.summaryVersion,0);
  assert.equal(fresh.quote,null);assert.equal(fresh.knowledgeStatus,'not_configured');assert.equal(fresh.feedback,'not_quoted');
  assert.equal(fresh.handoff,false);assert.equal(fresh.followupStatus,'pending');assert.equal(fresh.contactSubmitted,false);
  assert.deepEqual(fresh.attachments,[]);assert.deepEqual(fresh.notifications,[]);
  assert.equal(fresh.messages.length,1);assert.equal(fresh.messages[0].role,'assistant');
  assert.notEqual(fresh.messages[0].id,old.messages[0].id);assert.deepEqual(fresh.messages[0].attachments,[]);
  const freshStored=store.getConversation(fresh.id);
  assert.equal(freshStored.contact,null);assert.deepEqual(freshStored.quoteSources,[]);assert.deepEqual(freshStored.requestIds,[]);
  assert.equal(freshStored.notificationReason,'');
  assert.equal(Date.parse(fresh.expiresAt)-Date.parse(fresh.createdAt),RETENTION_MS);
  assert.ok(Date.parse(fresh.expiresAt)>Date.parse(old.expiresAt));
  assert.deepEqual(store.db.prepare('SELECT * FROM conversations WHERE id=?').get(old.id),oldRecord);
  assert.deepEqual(store.attachments(old.id),[attachment]);assert.deepEqual(store.notifications(old.id),oldNotifications);
  assert.deepEqual(json(await owner.get(`/api/conversations/${old.id}`)).conversation,oldPublic);
  assert.equal(readFileSync(filePath,'utf8'),attachment.text);
  const downloaded=await owner.get(`/api/files/${attachment.id}`);
  assert.equal(downloaded.status,200);assert.deepEqual(downloaded.body,Buffer.from(attachment.text));
  assert.equal((await session(owner)).id,fresh.id);

  const wrongAttachment=await owner.post(`/api/conversations/${fresh.id}/messages`)
    .send({content:'不应跨项目带入旧文件',requestId:'cross-project-file',attachmentIds:[attachment.id]});
  assert.equal(wrongAttachment.status,403);
  assert.deepEqual(store.getConversation(fresh.id),freshStored);
  assert.equal(modelCalls.length,0);
  // Reusing an old request id must still create a message in the new consultation.
  const updated=json(await owner.post(`/api/conversations/${fresh.id}/messages`)
    .send({content:'我想聊一个新的工作流项目',requestId:'old-message-request'})).conversation;
  assert.equal(modelCalls.length,1);assert.deepEqual(modelCalls[0].profile,emptyProfile);
  assert.deepEqual(modelCalls[0].attachments,[]);
  assert.deepEqual(modelCalls[0].messages.map(m=>m.content),[fresh.messages[0].content,'我想聊一个新的工作流项目']);
  assert.equal(updated.profile.project,'新的工作流项目');assert.equal(updated.messages.length,3);
  assert.equal(updated.contactSubmitted,false);assert.deepEqual(updated.notifications,[]);
  assert.deepEqual(store.db.prepare('SELECT * FROM conversations WHERE id=?').get(old.id),oldRecord);
  assert.deepEqual(store.notifications(old.id),oldNotifications);

  const freshAfterMessage=store.getConversation(fresh.id);
  const oldFeedback=json(await owner.post(`/api/conversations/${old.id}/messages`)
    .send({content:'太贵了',requestId:'old-feedback-after-new',summaryVersion:old.summaryVersion})).conversation;
  assert.equal(oldFeedback.feedback,'too_high');assert.deepEqual(oldFeedback.quote,old.quote);
  assert.deepEqual(store.getConversation(fresh.id),freshAfterMessage);
  assert.equal((await session(owner)).id,fresh.id);
  const oldDates=store.db.prepare('SELECT created_at,expires_at FROM conversations WHERE id=?').get(old.id);
  assert.equal(oldDates.created_at,createdAt);assert.equal(oldDates.expires_at,createdAt+RETENTION_MS);
  assert.equal(store.getConversation(old.id).expiresAt,old.expiresAt);
  assert.equal(readFileSync(filePath,'utf8'),attachment.text);
  for(const cid of [old.id,fresh.id]){
    assert.equal((await other.get(`/api/conversations/${cid}`)).status,404);
    assert.equal((await other.post(`/api/conversations/${cid}/messages`).send({content:'越权修改',requestId:'foreign'})).status,404);
  }
  assert.equal((await other.get(`/api/files/${attachment.id}`)).status,404);
});
test('unconfigured model honestly degrades and never quotes; message retry is idempotent',async t=>{
  const {app}=setup(t),a=request.agent(app),c=await session(a);const body={content:'做一个企业客服项目',requestId:'one'};
  const r=json(await a.post(`/api/conversations/${c.id}/messages`).send(body));assert.equal(r.degraded,true);assert.equal(r.conversation.quote,null);assert.equal(r.conversation.handoff,true);
  const repeat=json(await a.post(`/api/conversations/${c.id}/messages`).send(body));assert.equal(repeat.conversation.messages.length,r.conversation.messages.length);
  assert.equal((await a.post(`/api/conversations/${c.id}/confirm`).send({version:0})).status,409);
});
test('new scope text invalidates old quote even if extraction fails; stale confirmation rejected',async t=>{
  const {app,store}=setup(t),a=request.agent(app),c=store.getConversation((await session(a)).id);Object.assign(c,{profile,summaryReady:true,summaryConfirmed:true,summaryVersion:5,quote:{min:100,max:200,version:5,currency:'CNY'},feedback:'accepted'});store.saveConversation(c);
  const out=json(await a.post(`/api/conversations/${c.id}/messages`).send({content:'再新增一套财务审核模块',requestId:'scope'})).conversation;
  assert.equal(out.quote,null);assert.equal(out.summaryConfirmed,false);assert.equal(out.summaryVersion,6);assert.equal(out.feedback,'not_quoted');
  assert.equal((await a.post(`/api/conversations/${c.id}/feedback`).send({feedback:'accepted',version:5})).status,409);
});
test('mock quote confirmation, text feedback, contact consent and notification dedup work together',async t=>{
  const {app,store}=setup(t,{replyFn:async input=>{const latest=input.messages.at(-1);return {profile:input.profile,ready:true,degraded:false,reply:'',action:{type:'quote_feedback',summaryVersion:input.conversationState.summaryVersion,quoteVersion:input.conversationState.quote.version,sourceMessageId:latest.id,evidence:latest.content,scopeChanged:false,feedback:'too_high'}};},quoteFn:async({version})=>({status:'quoted',quote:{min:1000,max:2000,version,currency:'CNY',note:'参考'},sources:['case-1']})});const a=request.agent(app),c=store.getConversation((await session(a)).id);Object.assign(c,{profile,summaryReady:true,summaryVersion:2});store.saveConversation(c);
  let out=json(await a.post(`/api/conversations/${c.id}/confirm`).send({version:2})).conversation;assert.equal(out.quote.min,1000);assert.equal(out.quoteSources,undefined);
  out=json(await a.post(`/api/conversations/${c.id}/messages`).send({content:'太贵了',requestId:'price',summaryVersion:2})).conversation;assert.equal(out.feedback,'too_high');assert.equal(out.quote.min,1000);
  const contact={email:'demo@example.com',consent:true};assert.equal((await a.post(`/api/conversations/${c.id}/contact`).send({...contact,consent:undefined})).status,400);
  out=json(await a.post(`/api/conversations/${c.id}/contact`).send(contact)).conversation;assert.equal(out.contactSubmitted,true);assert.equal(out.contact,undefined);assert.equal(out.followupStatus,'pending');
  await a.post(`/api/conversations/${c.id}/contact`).send(contact);assert.equal(store.notifications(c.id).length,1);
});
test('admin role, encrypted secrets, session revocation, origin checks, and validation',async t=>{
  const {app,store,dir}=setup(t);store.createUser('admin',password,'admin');store.createUser('staff',password,'staff');const admin=request.agent(app),staff=request.agent(app);
  await login(admin);await staff.post('/api/admin/login').send({username:'staff',password});
  assert.equal((await request(app).get('/api/admin/settings')).status,401);assert.equal((await staff.get('/api/admin/settings')).status,403);
  const s=json(await admin.get('/api/admin/settings')).settings;
  s.model={baseUrl:'https://example.com/v1',name:'user-model',apiKey:'fake-test-secret-only'};
  const out=json(await admin.put('/api/admin/settings').send(s));assert.equal(out.settings.model.apiKey,'');assert.equal(out.settings.model.configured,true);
  assert.equal(store.db.prepare('SELECT value FROM settings').get().value.includes('fake-test-secret-only'),false);
  assert.equal((await admin.put('/api/admin/settings').set('Origin','https://evil.test').send(s)).status,403);
  assert.equal((await admin.put('/api/admin/settings').send({...s,wecom:{webhook:'https://evil.test/hook'}})).status,400);
  assert.equal((await admin.patch(`/api/admin/users/${store.users().find(u=>u.username==='staff').id}`).send({active:false})).status,200);
  assert.equal((await staff.get('/api/admin/me')).status,401);
  await admin.post('/api/admin/logout');assert.equal((await admin.get('/api/admin/me')).status,401);
});
test('contact fallback records project and 5MB rejects oversized files before parsing',async t=>{
  const {app}=setup(t),a=request.agent(app),c=await session(a);
  const out=json(await a.post(`/api/conversations/${c.id}/contact`).send({project:'公司工作流自动化项目',wechat:'example_user',consent:true}));assert.equal(out.conversation.contactSubmitted,true);assert.ok(out.message.includes('登记'));
  const upload=await a.post(`/api/conversations/${c.id}/attachments`).attach('file',Buffer.alloc(5_000_001),{filename:'large.pdf',contentType:'application/pdf'});assert.equal(upload.status,413);
});
test('attachments require owner or employee access and manual delete removes bytes',async t=>{
  const {app,store,dir}=setup(t),a=request.agent(app),b=request.agent(app),c=await session(a);const aid='file-test';writeFileSync(path.join(dir,'files',aid),'private');store.saveAttachment({id:aid,conversationId:c.id,name:'private.txt',mime:'text/plain',size:7});
  assert.equal((await b.get(`/api/files/${aid}`)).status,404);assert.equal((await a.get(`/api/files/${aid}`)).status,200);
  store.createUser('admin',password,'admin');const admin=request.agent(app);await login(admin);assert.equal((await admin.get(`/api/files/${aid}`)).status,200);
  await admin.delete(`/api/admin/conversations/${c.id}`);assert.equal(existsSync(path.join(dir,'files',aid)),false);assert.equal((await a.get(`/api/files/${aid}`)).status,404);
});
test('30 day cleanup deletes conversation attachments notifications with no sliding expiry',t=>{
  const {store,dir}=setup(t),c=store.createConversation('owner');const created=Date.parse(c.createdAt);assert.equal(Date.parse(c.expiresAt)-created,RETENTION_MS);
  writeFileSync(path.join(dir,'files','a'),'test');store.saveAttachment({id:'a',conversationId:c.id,name:'a',size:4});c.profile=profile;c.contact={email:'test@example.com',consent:true};store.saveConversation(c);queueLead(store,c);
  assert.equal(store.cleanup(created+RETENTION_MS-1),0);assert.equal(store.cleanup(created+RETENTION_MS),1);
  assert.equal(store.getConversation(c.id),null);assert.equal(store.notifications(c.id).length,0);assert.equal(existsSync(path.join(dir,'files','a')),false);
});
test('notification queue waits for config, retries rejection, sends mock success and cancels superseded payloads',async t=>{
  let calls=0;const {store,tick}=setup(t,{fetchImpl:async()=>{calls++;return new Response(JSON.stringify({errcode:calls===1?45009:0}),{status:200});}});
  const c=store.createConversation('owner');c.profile=profile;c.contact={email:'test@example.com',consent:true};store.saveConversation(c);queueLead(store,c);
  await tick();assert.equal(store.notifications(c.id)[0].status,'awaiting_configuration');assert.equal(calls,0);
  const settings=store.settings();settings.wecom.webhook='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fake-for-test';store.saveSettings(settings);
  store.db.prepare('UPDATE notifications SET next_at=0').run();await tick();assert.equal(store.notifications(c.id)[0].status,'retrying');
  store.db.prepare('UPDATE notifications SET next_at=0').run();await tick();assert.equal(store.notifications(c.id)[0].status,'sent');
  c.feedback='considering';queueLead(store,c);c.feedback='too_high';queueLead(store,c);assert.equal(store.notifications(c.id).filter(n=>n.status==='superseded').length,1);
});
test('long notification retains contact quote and features in bounded multipart text',()=>{
  const payload={...profile,features:Array.from({length:20},(_,i)=>`功能${i}：${'很长的功能描述'.repeat(20)}`),contact:{email:'visible@example.com'},quote:{min:12,max:34,currency:'CNY'},feedback:'accepted',reason:'待人工确认'};
  const parts=messageParts(payload);assert.ok(parts.length>1);assert.ok(parts.every(p=>Buffer.byteLength(p)<2048));assert.ok(parts.join('').includes('visible@example.com'));assert.ok(parts.join('').includes('12–34'));
  for(const feature of payload.features)assert.ok(parts.join('').replace(/【项目通知 \d+\/\d+】\n/g,'').includes(feature));
});
