import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runtime,client} from '../scripts/test-runtime.js';
import {t} from '../shared/i18n.js';
const samples=JSON.parse(readFileSync(new URL('../examples/cases.json',import.meta.url)));
const english=c=>`Project: ${t(c.title,'en')}\nScenario: ${t(c.scenario,'en')}\nFeatures: ${c.features.map(v=>t(v,'en')).join('; ')}\nInputs: ${t(c.inputs,'en')}\nOutputs: ${t(c.outputs,'en')}\nIntegrations: ${t(c.integrations,'en')}`;
test('双语Demo：英文真实HTTP流程与原始数据保持',async parent=>{
  const env=await runtime({csPort:3618,kbPort:3620});parent.after(env.stop);
  const en=client(env.cs,'en'),zh=client(env.cs,'zh'),kb=client(env.kb,'en'),admin=client(env.cs,'en');
  let c=(await en('/api/session')).conversation;
  const msg=async content=>(await en(`/api/conversations/${c.id}/messages`,{method:'POST',body:{content,summaryVersion:c.summaryVersion,requestId:crypto.randomUUID()}})).conversation;
  await parent.test('英文问候与中文并行咨询互不污染',async()=>{
    assert.match(c.messages[0].content,/Hi!/);assert(!/[\u3400-\u9fff]/.test(c.messages[0].content));
    assert.match((await zh('/api/session')).conversation.messages[0].content,/你好/);
  });
  await parent.test('英文追问、英文示例按同一CNY依据报价及方案',async()=>{
    c=await msg('Project: Product images and copy assistant');assert.match(c.messages.at(-1).content,/Which business scenario/);
    c=await msg(english(samples[0]));assert.equal(c.summaryReady,true);assert.equal(c.quote,null);
    c=await msg('Confirm');assert.equal(c.summaryConfirmed,true);assert.deepEqual([c.quote.min,c.quote.max,c.quote.currency],[8000,12000,'CNY']);
    assert.match(c.quote.note,/Fictional demo price/);assert.match(c.messages.at(-1).content,/Fictional proposal/);
    assert(!c.messages.filter(m=>m.role==='assistant').some(m=>/[\u3400-\u9fff]/.test(m.content)));
  });
  await parent.test('英文接受、邮件留资、本地回执和后台原文保留',async()=>{
    c=await msg('Accept');assert.equal(c.feedback,'accepted');
    c=await msg('I agree to project follow-up, email visitor@example.test');assert.equal(c.contactSubmitted,true);assert.match(c.messages.at(-1).content,/local demo receipt/);
    await admin('/demo/login',{status:302});const saved=(await admin(`/api/admin/conversations/${c.id}`)).conversation;
    assert.equal(saved.messages.findLast(m=>m.role==='user').content,'I agree to project follow-up, email visitor@example.test');
    assert.equal(saved.profile.project,t(samples[0].title,'en'));
    c=await msg('Stop contacting me');assert.equal(c.contactSubmitted,false);assert.match(c.messages.at(-1).content,/Follow-up notifications stopped/);
  });
  await parent.test('英文同类无价与新类型无案例',async()=>{
    c=(await en('/api/conversations',{method:'POST',body:{}})).conversation;c=await msg(english(samples[2]));c=await msg('Confirm');
    assert.equal(c.knowledgeStatus,'no_price');assert.equal(c.quote,null);assert.match(c.messages.at(-1).content,/Fictional proposal/);
    c=(await en('/api/conversations',{method:'POST',body:{}})).conversation;c=await msg('Project: Ocean buoy management\nScenario: Ocean buoy monitoring\nFeatures: Buoy positioning; Seawater temperature monitoring\nInputs: Buoy sensor data\nOutputs: Buoy location and temperature map\nIntegrations: Buoy IoT API');c=await msg('Confirm');
    assert.equal(c.knowledgeStatus,'no_match');assert.equal(c.quote,null);assert.match(c.messages.at(-1).content,/No comparable case/);
  });
  await parent.test('知识库显示英文种子、原件不改写、语言不改变草稿过滤',async()=>{
    await kb('/demo/login',{status:302});const projects=(await kb('/api/projects')).projects;
    assert.equal(projects.length,4);assert(projects.some(p=>p.title==='Product images and copy assistant (fictional demo)'));
    const detail=await kb('/api/projects/demo-commerce');assert.equal(detail.project.scenario,'Ecommerce product operations');assert.equal(detail.features[0],'Generate product hero images');
    assert.match(detail.files[0].extracted_text,/虚构/);assert.equal(detail.project.category,'AI Agent定制');
  });
  await parent.test('英文错误状态与无同意不触发留资',async()=>{
    await en('/api/admin/settings',{status:401});c=await msg('visitor@example.test');assert.equal(c.contactSubmitted,false);assert.match(c.messages.at(-1).content,/May we use/);
    const error=await en(`/api/conversations/${c.id}/confirm`,{method:'POST',body:{version:-1},status:409});assert(!/[\u3400-\u9fff]/.test(error.error));
  });
  await parent.test('英文草稿保存和无模型整理不会改写原件或虚构整理',async()=>{
    const detail=await kb('/api/projects/demo-draft');
    await kb('/api/projects/demo-draft/draft',{method:'PUT',body:{clientDraftVersion:detail.project.draft_version,title:detail.project.title,public_title:detail.project.public_title,public_summary:detail.project.public_summary,features:detail.features}});
    const chinese=client(env.kb,'zh');await chinese('/demo/login',{status:302});const raw=await chinese('/api/projects/demo-draft');assert.equal(raw.project.title,'未审核测试档案（虚构演示）');assert.equal(raw.features[0],'生成商品主图');assert.match(raw.files[0].extracted_text,/虚构/);
    const answer=await kb('/api/projects/demo-draft/organize/chat',{method:'POST',body:{message:'Please review the missing details',clientDraftVersion:raw.project.draft_version}});assert.equal(answer.patchApplied,false);assert.match(answer.reply,/No AI model/);
  });
});
