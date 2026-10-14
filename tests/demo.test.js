import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runtime,client } from '../scripts/test-runtime.js';
import { root } from '../scripts/paths.js';
const cases=JSON.parse(readFileSync(new URL('../examples/cases.json',import.meta.url)));
const text=c=>`项目：${c.title}\n场景：${c.scenario}\n功能：${c.features.join('；')}\n输入：${c.inputs}\n输出：${c.outputs}\n对接：${c.integrations}`;
test('隔离联合Demo真实HTTP业务链路',async t=>{
  const env=await runtime();t.after(()=>env.stop());
  const visitor=client(env.cs),staff=client(env.cs),kb=client(env.kb);
  const message=async(call,c,content)=>(await call(`/api/conversations/${c.id}/messages`,{method:'POST',body:{content,summaryVersion:c.summaryVersion,requestId:crypto.randomUUID()}})).conversation;
  let c=(await visitor('/api/session')).conversation;
  await t.test('首次匿名访问和离线模式标记',async()=>{assert.equal((await visitor('/demo/status')).mode,'offline');assert.equal(c.summaryConfirmed,false);});
  await t.test('按缺口补充，需求不会自行确认',async()=>{c=await message(visitor,c,'我想做一个电商项目');assert.match(c.messages.at(-1).content,/离线流程演示/);assert.equal(c.summaryReady,false);});
  await t.test('真实本机知识库检索，确认后返回方案和虚构价格',async()=>{
    c=await message(visitor,c,text(cases[0]));assert.equal(c.summaryReady,true);assert.equal(c.quote,null);
    c=await message(visitor,c,'确认');assert.equal(c.summaryConfirmed,true);assert.deepEqual([c.quote.min,c.quote.max],[8000,12000]);assert.match(c.quote.note,/虚构演示/);assert.match(c.messages.at(-1).content,/本机已发布演示案例/);
  });
  await t.test('接受参考价、聊天留资实际登记及本地通知',async()=>{
    c=await message(visitor,c,'接受');assert.equal(c.feedback,'accepted');
    c=await message(visitor,c,'同意联系我，邮箱 visitor@example.test');assert.equal(c.contactSubmitted,true);assert.match(c.messages.at(-1).content,/本地演示通知/);
    await staff('/demo/login',{status:302});
    let inbox;for(let i=0;i<30;i++){inbox=await staff('/demo/api/inbox');if(inbox.items.length)break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(inbox.items.length,1);assert.equal(inbox.localOnly,true);assert.match(inbox.items[0].parts.join(''),/visitor@example.test/);assert.match(inbox.items[0].parts.join(''),/8,000|8000/);
  });
  await t.test('新建对话隔离与刷新续接、其他访客不能读取',async()=>{
    const old=c;c=(await visitor('/api/conversations',{method:'POST',body:{}})).conversation;
    assert.notEqual(c.id,old.id);assert.equal(c.quote,null);assert.equal(c.contactSubmitted,false);assert.equal(c.profile.project,'');
    assert.equal((await visitor('/api/session')).conversation.id,c.id);
    await client(env.cs)(`/api/conversations/${old.id}`,{status:404});
  });
  await t.test('同类无价格：保留方案并交人工',async()=>{
    c=await message(visitor,c,text(cases[2]));c=(await visitor(`/api/conversations/${c.id}/confirm`,{method:'POST',body:{version:c.summaryVersion}})).conversation;
    assert.equal(c.knowledgeStatus,'no_price');assert.equal(c.quote,null);assert.match(c.messages.at(-1).content,/虚构方案/);
  });
  await t.test('新类型不生成报价',async()=>{
    c=(await visitor('/api/conversations',{method:'POST',body:{}})).conversation;
    c=await message(visitor,c,'项目：海洋浮标设备管理\n场景：海洋浮标监测\n功能：浮标定位；海水温度监测\n输入：浮标传感器数据\n输出：浮标位置与温度地图\n对接：浮标物联网接口');
    c=(await visitor(`/api/conversations/${c.id}/confirm`,{method:'POST',body:{version:c.summaryVersion}})).conversation;
    assert.equal(c.knowledgeStatus,'no_match');assert.equal(c.quote,null);assert.equal(c.handoff,true);
  });
  await t.test('管理鉴权、一键入口跨站保护及通知保持本地',async()=>{
    await client(env.cs)('/api/admin/settings',{status:401});await client(env.cs)('/demo/api/inbox',{status:401});
    await client(env.cs)('/demo/login',{headers:{Origin:'https://example.test'},status:403});
    await client(env.kb)('/demo/login',{headers:{Origin:'https://example.test'},status:403});
    const {settings}=await staff('/api/admin/settings');
    await staff('/api/admin/settings',{method:'PUT',body:{...settings,wecom:{webhook:'https://example.test/not-a-robot'}}});
    assert.equal((await staff('/api/admin/settings')).settings.wecom.configured,true);
  });
  await t.test('知识库草稿不被客服引用；已发布撤回后不沿用',async()=>{
    await kb('/demo/login',{status:302});
    const projects=(await kb('/api/projects')).projects;assert.equal(projects.length,4);assert.equal(projects.filter(p=>p.status==='approved').length,3);
    const credentials=JSON.parse(readFileSync(path.join(env.dir,'credentials.json')));
    const search=body=>kb('/api/integrations/customer-service/search',{method:'POST',body,headers:{Authorization:`Bearer ${credentials.integrationKey}`}});
    let found=await search({query:cases[0].title,profile:{project:cases[0].title}});assert(!found.cases.some(v=>v.id.includes('demo-draft')));assert(found.cases.some(v=>v.id.startsWith('demo-commerce')&&v.match));
    await kb('/api/projects/demo-commerce/review/revoke',{method:'POST',body:{reason:'演示撤回验证'}});
    found=await search({query:cases[0].title,profile:{project:cases[0].title}});assert(!found.cases.some(v=>v.id.startsWith('demo-commerce')));
    await kb('/api/integrations/customer-service/search',{method:'POST',body:{query:'demo'},status:401});
  });
  await t.test('客服5MB上限和文件归属校验',async()=>{
    const form=new FormData();form.set('file',new Blob([new Uint8Array(5_000_001)],{type:'text/plain'}),'too-large.txt');
    await visitor(`/api/conversations/${c.id}/attachments`,{method:'POST',raw:form,status:413});
    await visitor(`/api/conversations/${c.id}/messages`,{method:'POST',body:{content:'看看附件',requestId:crypto.randomUUID(),summaryVersion:c.summaryVersion,attachmentIds:['not-owned']},status:403});
  });
  await t.test('重启不覆盖归档修改、咨询和本地通知',async()=>{
    const cid=c.id;await env.restart();
    assert.equal((await visitor('/api/session')).conversation.id,cid);
    await kb('/demo/login',{status:302});
    assert.equal((await kb('/api/projects')).projects.find(p=>p.id==='demo-commerce').status,'revoked');
    await staff('/demo/login',{status:302});assert.equal((await staff('/demo/api/inbox')).items.length,1);
  });
  mkdirSync(path.join(root,'artifacts'),{recursive:true});
  writeFileSync(path.join(root,'artifacts/integration.json'),JSON.stringify({date:new Date().toISOString(),mode:'offline',services:'real local HTTP and SQLite',result:'以测试运行器最终退出码为准',scenarios:11,externalModelCalls:0,realWecomCalls:0,realCustomerData:false},null,2));
});
