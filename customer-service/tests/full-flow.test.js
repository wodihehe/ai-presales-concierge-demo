import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { generateReply, retrieveQuote } from '../server/intelligence.js';

// Real application routes, adapters and SQLite, with mocked external HTTP only.
// All business data, recipients, prices and credentials are synthetic test data.
const PASSWORD = 'synthetic-full-flow-password-123';
const MODEL_SECRET = 'synthetic-model-key-never-real';
const KNOWLEDGE_SECRET = 'synthetic-knowledge-key-never-real';
const SOURCE_ID = 'synthetic-source-for-admin-only';
const SOURCE_PROSE = 'synthetic-private-customer-and-cost-do-not-disclose';
const CUSTOMER_EMAIL = 'synthetic-customer@example.test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0YAAAAASUVORK5CYII=', 'base64');
const profile = { project: '模拟企业问答项目', scenario: '员工查资料', problem: '查找文档太慢', features: ['文档检索', '有出处的问答'], inputs: '公司 PDF 文件', outputs: '提供资料回答', integrations: '暂不对接', budget: '不确定', timeline: '不确定' };
const content = '模拟企业问答项目，场景是员工查资料，解决查找文档太慢。功能是文档检索、有出处的问答；输入公司 PDF 文件，输出提供资料回答，暂不对接。预算和期望时间都不确定。';
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
function body(response) { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; }
function transport() {
  const calls = { model: [], knowledge: [], notifications: [] };
  const fetchImpl = async (url, options) => {
    const address = new URL(url);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const payload = JSON.parse(options.body);
    if (address.hostname === 'model.example.test') {
      calls.model.push(payload);
      assert.equal(address.pathname, '/v1/chat/completions');
      assert.equal(options.headers.Authorization, `Bearer ${MODEL_SECRET}`);
      const parts = payload.messages[1].content;
      const input = JSON.parse(Array.isArray(parts) ? parts[0].text : parts);
      const user = input.conversation.findLast(message => message.role === 'user');
      assert.ok(user?.id);
      assert.equal(user.text, content);
      const evidence = Object.fromEntries(Object.entries(profile).map(([field, value]) => [field, Array.isArray(value)
        ? value.map(quote => ({ source: `message:${user.id}`, quote }))
        : { source: `message:${user.id}`, quote: value }]));
      return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ profile, evidence, followUp:{acknowledgement:'',questions:[]},action:{type:'continue',summaryVersion:input.conversationState.summaryVersion,quoteVersion:input.conversationState.quote?.version??null,sourceMessageId:user.id,evidence:user.text,scopeChanged:true}, reply: '必须忽略的任意模型全文，最终报价一元' }) } }] });
    }
    if (address.hostname === 'knowledge.example.test') {
      calls.knowledge.push(payload);
      assert.equal(options.headers.Authorization, `Bearer ${KNOWLEDGE_SECRET}`);
      assert.deepEqual(payload.profile, profile);
      return json({ cases: [{ id: SOURCE_ID, category: 'enterprise_qa', title: '模拟已审核项目', summary: SOURCE_PROSE, features: profile.features, approved: true, public: true, match: true, price: { min: 12000, max: 18000, currency: 'CNY' } }] });
    }
    if (address.hostname === 'qyapi.weixin.qq.com') {
      calls.notifications.push(payload.text.content);
      assert.equal(payload.msgtype, 'text');
      return json({ errcode: 0 });
    }
    throw new Error('Unexpected external request in synthetic test');
  };
  return { fetchImpl, calls };
}
async function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'concierge-full-flow-'));
  const store = openStore(dir);
  const { fetchImpl, calls } = transport();
  const { app, tick } = createApp(store, {
    rateLimits: false,
    replyFn: args => generateReply({ ...args, fetchImpl }),
    quoteFn: args => retrieveQuote({ ...args, fetchImpl }),
    fetchImpl,
  });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.createUser('full-flow-admin', PASSWORD, 'admin');
  const admin = request.agent(app);
  body(await admin.post('/api/admin/login').send({ username: 'full-flow-admin', password: PASSWORD }));
  const settings = body(await admin.get('/api/admin/settings')).settings;
  settings.companyName = '模拟测试公司';
  settings.companyDescription = '提供企业知识问答与工作流服务。';
  settings.model = { baseUrl: 'https://model.example.test/v1', name: 'synthetic-model', apiKey: MODEL_SECRET };
  settings.knowledge = { url: 'https://knowledge.example.test/search', apiKey: KNOWLEDGE_SECRET };
  settings.wecom = { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-full-flow-only' };
  const saved = body(await admin.put('/api/admin/settings').send(settings)).settings;
  assert.equal(saved.model.apiKey, '');
  assert.equal(saved.knowledge.apiKey, '');
  assert.equal(saved.wecom.webhook, '');
  const customer = request.agent(app);
  const conversation = body(await customer.get('/api/session')).conversation;
  return { app, store, tick, admin, customer, conversation, dir, calls };
}
async function quoteProject(env, attachmentIds = []) {
  const summarized = body(await env.customer.post(`/api/conversations/${env.conversation.id}/messages`).send({ content, requestId: 'synthetic-complete-requirements', attachmentIds })).conversation;
  assert.equal(summarized.summaryReady, true);
  assert.equal(summarized.summaryConfirmed, false);
  assert.deepEqual(summarized.profile, profile);
  assert.match(summarized.messages.at(-1).content, /待你确认/);
  assert.doesNotMatch(summarized.messages.at(-1).content, /最终报价一元/);
  return body(await env.customer.post(`/api/conversations/${env.conversation.id}/confirm`).send({ version: summarized.summaryVersion })).conversation;
}
function assertPublicPrivacy(conversation) {
  assert.equal(conversation.quoteSources, undefined);
  assert.equal(conversation.contact, undefined);
  assert.equal(conversation.settings, undefined);
  assert.equal(conversation.requestIds, undefined);
  assert.doesNotMatch(JSON.stringify(conversation), new RegExp([MODEL_SECRET, KNOWLEDGE_SECRET, SOURCE_ID, SOURCE_PROSE, CUSTOMER_EMAIL].join('|')));
  for (const notification of conversation.notifications) {
    assert.equal(notification.payload, undefined);
    assert.equal(notification.fingerprint, undefined);
    assert.equal(notification.renderedParts, undefined);
    assert.equal(notification.formatVersion, undefined);
  }
}

test('complete local customer flow uses real model/KB adapters and routes with mocked external transports only', async t => {
  const env = await setup(t);
  const quoted = await quoteProject(env);
  assert.equal(quoted.knowledgeStatus, 'quoted');
  assert.equal(quoted.summaryConfirmed, true);
  assert.equal(quoted.quote.min, 12000);
  assert.equal(quoted.quote.max, 18000);
  assert.match(quoted.quote.note, /最终方案和报价由人工确认/);
  assertPublicPrivacy(quoted);
  const accepted = body(await env.customer.post(`/api/conversations/${quoted.id}/feedback`).send({ feedback: 'accepted', version: quoted.quote.version })).conversation;
  assert.equal(accepted.feedback, 'accepted');
  assert.equal(accepted.followupStatus, 'pending');
  const submitted = body(await env.customer.post(`/api/conversations/${quoted.id}/contact`).send({ email: CUSTOMER_EMAIL, consent: true })).conversation;
  assert.equal(submitted.contactSubmitted, true);
  assertPublicPrivacy(submitted);
  assert.equal(submitted.notifications.length, 1);
  assert.equal(submitted.notifications[0].status, 'pending');
  await env.tick();
  assert.equal(env.calls.model.length, 1);
  assert.equal(env.calls.knowledge.length, 1);
  assert.equal(env.calls.notifications.length, 1);
  const sent = env.calls.notifications.join('');
  assert.match(sent, /模拟企业问答项目/);
  assert.match(sent, /12000–18000 CNY/);
  assert.match(sent, /客户已确认/);
  assert.match(sent, /接受参考区间（待人工确认）/);
  assert.ok(sent.includes(CUSTOMER_EMAIL));
  assert.doesNotMatch(sent, new RegExp(`${SOURCE_PROSE}|${SOURCE_ID}|${MODEL_SECRET}`));
  const resumed = body(await env.customer.get('/api/session')).conversation;
  assert.equal(resumed.id, quoted.id);
  assert.equal(resumed.notifications[0].status, 'sent');
  assertPublicPrivacy(resumed);
  assert.equal((await request(env.app).get(`/api/conversations/${quoted.id}`)).status, 404);
  const staffView = body(await env.admin.get(`/api/admin/conversations/${quoted.id}`)).conversation;
  assert.equal(staffView.contact.email, CUSTOMER_EMAIL);
  assert.equal(staffView.contact.consent, true);
  assert.deepEqual(staffView.quoteSources, [SOURCE_ID]);
  assert.equal(staffView.notifications[0].status, 'sent');
  assert.deepEqual(staffView.profile, profile);
  assert.equal(staffView.feedback, 'accepted');
  assert.equal(staffView.followupStatus, 'pending');
  assert.equal(staffView.quote.version, staffView.summaryVersion);
  body(await env.customer.post(`/api/conversations/${quoted.id}/contact`).send({ email: CUSTOMER_EMAIL, consent: true }));
  await env.tick();
  assert.equal(env.calls.notifications.length, 1, 'duplicate contact submission must not notify twice');
});

test('invalid email and digit-free phone fail before contact persistence or notification', async t => {
  const env = await setup(t);
  for (const invalid of [{ email: 'missing-at-sign.example.test' }, { phone: '-------' }, { phone: '+12' }]) {
    const result = await env.customer.post(`/api/conversations/${env.conversation.id}/contact`).send({ ...invalid, project: profile.project, consent: true });
    assert.equal(result.status, 400);
  }
  assert.equal(env.store.getConversation(env.conversation.id).contact, null);
  assert.deepEqual(env.store.notifications(env.conversation.id), []);
  await env.tick();
  assert.equal(env.calls.notifications.length, 0);
});

test('single attachment deletion removes private bytes and references and invalidates any pending old quote', async t => {
  const env = await setup(t);
  const attachment = body(await env.customer.post(`/api/conversations/${env.conversation.id}/attachments`).attach('file', PNG, { filename: 'synthetic-requirement.png', contentType: 'image/png' })).attachment;
  assert.equal(attachment.status, 'image_ready');
  const quoted = await quoteProject(env, [attachment.id]);
  body(await env.customer.post(`/api/conversations/${quoted.id}/feedback`).send({ feedback: 'accepted', version: quoted.quote.version }));
  body(await env.customer.post(`/api/conversations/${quoted.id}/contact`).send({ email: CUSTOMER_EMAIL, consent: true }));
  assert.equal((await request(env.app).get(`/api/files/${attachment.id}`)).status, 404);
  assert.equal((await env.customer.get(`/api/files/${attachment.id}`)).status, 200);
  assert.equal((await env.customer.delete(`/api/admin/files/${attachment.id}`)).status, 401);
  body(await env.admin.delete(`/api/admin/files/${attachment.id}`));
  assert.equal(existsSync(path.join(env.dir, 'files', attachment.id)), false);
  assert.equal(env.store.attachment(attachment.id), null);
  assert.equal((await env.customer.get(`/api/files/${attachment.id}`)).status, 404);
  assert.equal((await env.admin.get(`/api/files/${attachment.id}`)).status, 404);
  const current = body(await env.customer.get(`/api/conversations/${quoted.id}`)).conversation;
  assert.equal(current.attachments.length, 0);
  assert.ok(current.messages.every(message => !message.attachments.some(file => file.id === attachment.id)));
  assert.equal(current.quote, null);
  assert.equal(current.summaryReady, false);
  assert.equal(current.summaryConfirmed, false);
  assert.equal(current.feedback, 'not_quoted');
  await env.tick();
  assert.ok(!env.calls.notifications.some(message => message.includes('12000–18000')), 'deleted evidence must not leave an old priced notification queued');
});
