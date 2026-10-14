// [SYNTHETIC_FIXTURE] API and race regressions; never use the company database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setupTestDatabase } from './helpers/testDb.js';
import { createApp } from '../server/index.js';
import { CONFIG } from '../server/config.js';
import { createSessionToken } from '../server/middleware/auth.js';
import { OrganizerService } from '../server/services/organizerService.js';
import { ModelClient } from '../server/services/modelClient.js';
import { SearchService } from '../server/services/searchService.js';

test('Codex acceptance regressions [SYNTHETIC_FIXTURE]', async t => {
  const db = setupTestDatabase();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const users = ['owner', 'other', 'admin'].map(id => ({ id, username: id, role: id === 'admin' ? 'admin' : 'staff', token_version: 1 }));
  for (const u of users) db.prepare("INSERT INTO users VALUES (?, ?, '', '', ?, ?, 0, 1, datetime('now'), datetime('now'))").run(u.id, u.id, u.role, u.id);
  const tokens = Object.fromEntries(users.map(u => [u.id, createSessionToken(u)]));
  async function api(route, { user = 'owner', method = 'GET', body } = {}) {
    const res = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[user]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  }
  function project(status = 'draft') {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO projects (id,title,creator_id,status,public_title,public_summary,inputs,outputs,deliverables,created_at,updated_at) VALUES (?,'[SYNTHETIC_FIXTURE] 工单工作流','owner',?,'工单工作流','自动工单流转','输入保留','输出保留','交付保留',datetime('now'),datetime('now'))").run(id,status);
    return id;
  }
  const snapshot = id => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);

  await t.test('页面实际使用的整理和审核地址可达', async () => {
    const id = project();
    const chat = await api(`/api/projects/${id}/organize/chat`, { method:'POST', body:{message:'[SYNTHETIC_FIXTURE] 补充',clientDraftVersion:1} });
    assert.equal(chat.status,200);
    const submit = await api(`/api/projects/${id}/review/submit`,{method:'POST'});
    assert.equal(submit.status,200);
    const approval = await api(`/api/projects/${id}/review/approve`,{method:'POST',body:{clientDraftVersion:snapshot(id).draft_version}});
    assert.equal(approval.status,200);
  });
  await t.test('其他员工不能修改他人草稿', async () => {
    const id=project();
    const res=await api(`/api/projects/${id}/draft`,{user:'other',method:'PUT',body:{title:'越权修改',clientDraftVersion:1}});
    assert.equal(res.status,403);
    assert.notEqual(snapshot(id).title,'越权修改');
  });
  await t.test('已发布案例必须撤回后才能修改，管理员同样受限', async () => {
    const id=project('approved');
    for(const user of ['owner','admin']) {
      const res=await api(`/api/projects/${id}/draft`,{user,method:'PUT',body:{title:'未经审核新内容',clientDraftVersion:1}});
      assert.equal(res.status,409);
    }
    assert.equal(snapshot(id).draft_version,1);
  });
  await t.test('审核必须携带整数版本并处于待审状态',async()=>{
    for(const version of [undefined,'1',null]) {
      const id=project('pending_review');
      const res=await api(`/api/projects/${id}/approve`,{method:'POST',body:{clientDraftVersion:version}});
      assert.equal(res.status,409);
      assert.equal(snapshot(id).status,'pending_review');
    }
    const id=project();
    const res=await api(`/api/projects/${id}/approve`,{method:'POST',body:{clientDraftVersion:1}});
    assert.equal(res.status,409);
  });
  await t.test('手动保存保留未出现在表单的输入输出交付物',async()=>{
    const id=project();
    const res=await api(`/api/projects/${id}/draft`,{method:'PUT',body:{title:'已改名称',clientDraftVersion:1}});
    assert.equal(res.status,200);
    assert.equal(snapshot(id).inputs,'输入保留');
    assert.equal(snapshot(id).outputs,'输出保留');
    assert.equal(snapshot(id).deliverables,'交付保留');
  });
  await t.test('迟到AI聊天补丁不能覆盖人工修改',async()=>{
    const id=project();
    let resolveReply;
    const originalConfigured=ModelClient.isConfigured,originalChat=ModelClient.chatCompletion;
    ModelClient.isConfigured=()=>true;
    ModelClient.chatCompletion=()=>new Promise(r=>{resolveReply=r;});
    try {
      const pending=OrganizerService.handleChat(id,'owner','[SYNTHETIC_FIXTURE] 更正',1);
      OrganizerService.directUpdateDraft(id,'owner',{title:'人工最新标题',clientDraftVersion:1});
      resolveReply({success:true,content:JSON.stringify({reply:'旧回复',patch:{title:'迟到标题'}})});
      await pending;
      assert.equal(snapshot(id).title,'人工最新标题');
    } finally {ModelClient.isConfigured=originalConfigured;ModelClient.chatCompletion=originalChat;}
  });
  await t.test('只修改功能也会递增审核版本',async()=>{
    const id=project();
    const originalConfigured=ModelClient.isConfigured,originalChat=ModelClient.chatCompletion;
    ModelClient.isConfigured=()=>true;
    ModelClient.chatCompletion=async()=>({success:true,content:JSON.stringify({reply:'更新功能',patch:{features:['人工补充工单查询']}})});
    try {await OrganizerService.handleChat(id,'owner','补充工单查询',1);assert.equal(snapshot(id).draft_version,2);}
    finally{ModelClient.isConfigured=originalConfigured;ModelClient.chatCompletion=originalChat;}
  });
  await t.test('无模型整理不覆盖现有草稿或虚构一期',async()=>{
    const id=project();
    db.prepare("UPDATE projects SET overview='人工方案保留' WHERE id=?").run(id);
    db.prepare("INSERT INTO project_files(id,project_id,original_name,stored_filename,parse_status,extracted_text,uploaded_by,created_at) VALUES (? ,?,'合成.txt','unused.txt','parsed','[SYNTHETIC_FIXTURE] 方案','owner',datetime('now'))").run(crypto.randomUUID(),id);
    await OrganizerService.extractDraft(id,'owner');
    assert.equal(snapshot(id).overview,'人工方案保留');
    assert.equal(db.prepare('SELECT count(*) n FROM project_phases WHERE project_id=?').get(id).n,0);
  });
  await t.test('未知分期关系与超过两位小数不能产生参考价格',()=>{
    db.prepare("UPDATE project_phases SET relation='unknown' WHERE id='phase_ecom_1'").run();
    let result=SearchService.searchFormalCases({query:'跨境电商退换货工单工作流'});
    assert.equal(result.cases.find(c=>c.id.startsWith('syn_proj_ecommerce_agent')).price,null);
    db.prepare("UPDATE project_phases SET relation='standalone',amount_min=12.345,amount_max=12.345 WHERE id='phase_ecom_1'").run();
    result=SearchService.searchFormalCases({query:'跨境电商退换货工单工作流'});
    assert.equal(result.cases.find(c=>c.id.startsWith('syn_proj_ecommerce_agent')).price,null);
  });
  await t.test('上下文不返回禁用价格的内部原文，也不回退内部摘要',()=>{
    const secret='SYNTHETIC_PRIVATE_COST';
    db.prepare("UPDATE project_phases SET raw_amount_text=? WHERE project_id='syn_proj_noprice_case'").run(secret);
    let result=SearchService.getStyleAndQuoteContext({query:'政企内部规章制度问答'});
    assert.equal(JSON.stringify(result).includes(secret),false);
    db.prepare("UPDATE projects SET public_summary='',overview=? WHERE id='syn_proj_noprice_case'").run(secret);
    result=SearchService.getStyleAndQuoteContext({query:'政企内部规章制度问答'});
    assert.equal(JSON.stringify(result).includes(secret),false);
  });
  await t.test('最后管理员布尔停用与降级被拒绝',async()=>{
    for(const body of [{disabled:true},{role:'staff'},{disabled:2},{disabled:-1}]) {
      const res=await api('/api/users/admin',{user:'admin',method:'PUT',body});
      assert.equal(res.status,400);
    }
  });
});
