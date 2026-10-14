import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { queueLead, messageParts } from '../server/notifications.js';

// Synthetic local fixtures and transport mocks only; these tests never call a
// live model, knowledge service, or enterprise WeChat bot.
const profile = {
  project: '模拟企业问答项目', scenario: '员工查资料', problem: '查文档耗时', features: ['文档搜索', '有出处的问答'],
  inputs: '公司文件', outputs: '资料回答', integrations: '暂不对接', budget: '不确定', timeline: '不确定',
};
const password = 'mock-only-race-password-123';
const okResponse = () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'concierge-races-'));
  const store = openStore(dir);
  const application = createApp(store, { rateLimits: false, ...options });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...application, store };
}
function body(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function visitor(app) {
  const agent = request.agent(app);
  const conversation = body(await agent.get('/api/session')).conversation;
  return { agent, conversation };
}
async function administrator(app, store) {
  store.createUser('race-admin', password, 'admin');
  const agent = request.agent(app);
  body(await agent.post('/api/admin/login').send({ username: 'race-admin', password }));
  return agent;
}
function configureMockWebhook(store) {
  const settings = store.settings();
  settings.wecom.webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=mock-race-only';
  store.saveSettings(settings);
}
function lead(store, { multipart = false } = {}) {
  const conversation = store.createConversation('mock-owner');
  conversation.profile = { ...profile, features: multipart ? Array.from({ length: 8 }, (_, i) => `功能${i}：${'需要审核的业务内容'.repeat(25)}`) : [...profile.features] };
  conversation.contact = { email: 'mock-customer@example.test', consent: true };
  store.saveConversation(conversation);
  queueLead(store, conversation);
  return conversation;
}

test('scope revision plus degraded extraction cannot confirm or reprice the old complete profile', async t => {
  let quoteCalls = 0;
  const { app, store } = setup(t, { quoteFn: async () => { quoteCalls++; return { status: 'quoted', quote: { min: 1, max: 2, currency: 'CNY' }, sources: [] }; } });
  const { agent, conversation } = await visitor(app);
  const saved = store.getConversation(conversation.id);
  Object.assign(saved, { profile, summaryReady: true, summaryConfirmed: true, summaryVersion: 7, quote: { min: 100, max: 200, currency: 'CNY', version: 7 }, feedback: 'accepted' });
  store.saveConversation(saved);
  // No model configured: exercise the real degraded adapter, not a fake ready flag.
  const changed = body(await agent.post(`/api/conversations/${conversation.id}/messages`).send({ content: '新加财务自动审核模块，原范围需要修改', requestId: 'scope-revision' }));
  assert.equal(changed.degraded, true);
  assert.equal(changed.conversation.quote, null);
  assert.equal(changed.conversation.summaryReady, false);
  assert.equal(changed.conversation.summaryConfirmed, false);
  const confirmed = await agent.post(`/api/conversations/${conversation.id}/confirm`).send({ version: changed.conversation.summaryVersion });
  assert.equal(confirmed.status, 400);
  assert.equal(quoteCalls, 0);
  assert.equal(store.getConversation(conversation.id).quote, null);
});

test('admin follow-up update is blocked during a model await and persists when retried afterward', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  const { app, store } = setup(t, { replyFn: async () => { entered.resolve(); await release.promise; return { profile, ready: true, degraded: false, reply: '模拟待确认总结' }; } });
  const { agent, conversation } = await visitor(app);
  const admin = await administrator(app, store);
  const pending = agent.post(`/api/conversations/${conversation.id}/messages`).send({ content: '补充需求', requestId: 'delayed-model' }).then(response => response);
  try {
    await entered.promise;
    const concurrent = await admin.patch(`/api/admin/conversations/${conversation.id}`).send({ followupStatus: 'following' });
    assert.equal(concurrent.status, 409);
  } finally { release.resolve(); }
  body(await pending);
  body(await admin.patch(`/api/admin/conversations/${conversation.id}`).send({ followupStatus: 'following' }));
  assert.equal(store.getConversation(conversation.id).followupStatus, 'following');
});

test('superseding a multipart notification during fetch cannot revive its status or send remaining old parts', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  const delivered = [];
  const { store, tick } = setup(t, { fetchImpl: async (_, options) => {
    delivered.push(JSON.parse(options.body).text.content);
    if (delivered.length === 1) { entered.resolve(); await release.promise; }
    return okResponse();
  } });
  configureMockWebhook(store);
  const conversation = lead(store, { multipart: true });
  const original = store.notifications(conversation.id)[0];
  assert.ok(messageParts(original.payload).length > 1);
  const running = tick();
  try {
    await entered.promise;
    conversation.feedback = 'too_high';
    store.saveConversation(conversation);
    queueLead(store, conversation);
    assert.equal(store.notifications(conversation.id).find(item => item.id === original.id).status, 'superseded');
  } finally { release.resolve(); }
  await running;
  assert.equal(delivered.length, 1, 'an already dispatched first part cannot be recalled, but later old parts must stop');
  assert.equal(store.notifications(conversation.id).find(item => item.id === original.id).status, 'superseded');
  await tick();
  const current = store.notifications(conversation.id).find(item => item.payload.feedback === 'too_high');
  assert.equal(current.status, 'sent');
  assert.ok(delivered.slice(1).join('').includes('价格偏高'));
});

test('deleting a lead during multipart fetch stops later parts and does not recreate notification records', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const { store, tick } = setup(t, { fetchImpl: async () => { calls++; if (calls === 1) { entered.resolve(); await release.promise; } return okResponse(); } });
  configureMockWebhook(store);
  const conversation = lead(store, { multipart: true });
  assert.ok(messageParts(store.notifications(conversation.id)[0].payload).length > 1);
  const running = tick();
  try { await entered.promise; store.deleteConversation(conversation.id); } finally { release.resolve(); }
  await running;
  assert.equal(calls, 1);
  assert.equal(store.getConversation(conversation.id), null);
  assert.deepEqual(store.notifications(conversation.id), []);
  await tick();
  assert.equal(calls, 1);
});

test('A to B to A feedback transitions requeue the latest state while consecutive duplicates stay deduplicated', async t => {
  let calls = 0;
  const { store, tick } = setup(t, { fetchImpl: async () => { calls++; return okResponse(); } });
  configureMockWebhook(store);
  const conversation = lead(store);
  conversation.feedback = 'considering'; queueLead(store, conversation);
  conversation.feedback = 'not_quoted'; queueLead(store, conversation);
  assert.equal(store.notifications(conversation.id).filter(item => item.status === 'pending').length, 1);
  await tick();
  assert.equal(calls, 1, 'only the latest state is sent when all changes happened before dispatch');
  assert.equal(store.notifications(conversation.id).find(item => item.payload.feedback === 'not_quoted').status, 'sent');
  queueLead(store, conversation);
  await tick();
  assert.equal(calls, 1, 'same consecutive payload does not send twice');
  conversation.feedback = 'considering'; queueLead(store, conversation); await tick();
  conversation.feedback = 'not_quoted'; queueLead(store, conversation); await tick();
  assert.equal(calls, 3, 'a genuine later return to a previously sent state still needs an update');
});

test('explicit contact consent withdrawal in chat cancels pending delivery and cannot be retried', async t => {
  let calls = 0;
  const { app, store, tick } = setup(t, { fetchImpl: async () => { calls++; return okResponse(); } });
  configureMockWebhook(store);
  const { agent, conversation } = await visitor(app);
  const admin = await administrator(app, store);
  body(await agent.post(`/api/conversations/${conversation.id}/contact`).send({ project: profile.project, email: 'mock-customer@example.test', consent: true }));
  const notification = store.notifications(conversation.id)[0];
  const withdrawn = body(await agent.post(`/api/conversations/${conversation.id}/messages`).send({ content: '不要联系我，撤回联系同意', requestId: 'withdraw-contact' }));
  assert.equal(store.getConversation(conversation.id).contact.consent, false);
  assert.equal(withdrawn.conversation.contactSubmitted, false);
  await tick();
  assert.equal(calls, 0);
  assert.equal(queueLead(store, store.getConversation(conversation.id)), false);
  const retry = await admin.post(`/api/admin/notifications/${notification.id}/retry`);
  assert.ok(retry.status >= 400 && retry.status < 500);
  await tick();
  assert.equal(calls, 0);
});

test('contact endpoint also accepts withdrawing an existing consent without resubmitting personal information', async t => {
  let calls = 0;
  const { app, store, tick } = setup(t, { fetchImpl: async () => { calls++; return okResponse(); } });
  configureMockWebhook(store);
  const { agent, conversation } = await visitor(app);
  body(await agent.post(`/api/conversations/${conversation.id}/contact`).send({ project: profile.project, email: 'mock-customer@example.test', consent: true }));
  const withdrawn = body(await agent.post(`/api/conversations/${conversation.id}/contact`).send({ consent: false }));
  assert.equal(withdrawn.conversation.contactSubmitted, false);
  assert.equal(store.getConversation(conversation.id).contact.consent, false);
  await tick();
  assert.equal(calls, 0);
});

test('a fresh explicit consent after withdrawal requeues even when contact and project are unchanged', async t => {
  let calls = 0;
  const { app, store, tick } = setup(t, { fetchImpl: async () => { calls++; return okResponse(); } });
  configureMockWebhook(store);
  const { agent, conversation } = await visitor(app);
  const contact = { project: profile.project, email: 'mock-customer@example.test', consent: true };
  body(await agent.post(`/api/conversations/${conversation.id}/contact`).send(contact));
  body(await agent.post(`/api/conversations/${conversation.id}/contact`).send({ consent: false }));
  await tick();
  assert.equal(calls, 0);
  body(await agent.post(`/api/conversations/${conversation.id}/contact`).send(contact));
  await tick();
  assert.equal(calls, 1);
});

test('a request for a human that also changes scope invalidates the old quote before handing off', async t => {
  const { app, store } = setup(t);
  const { agent, conversation } = await visitor(app);
  const saved = store.getConversation(conversation.id);
  Object.assign(saved, { profile, summaryReady: true, summaryConfirmed: true, summaryVersion: 3, quote: { min: 100, max: 200, currency: 'CNY', version: 3 }, feedback: 'accepted' });
  store.saveConversation(saved);
  const changed = body(await agent.post(`/api/conversations/${conversation.id}/messages`).send({ content: '还要新增财务自动审核功能，帮我转人工', requestId: 'scope-and-handoff' })).conversation;
  assert.equal(changed.handoff, true);
  assert.equal(changed.quote, null);
  assert.equal(changed.summaryConfirmed, false);
  assert.equal(changed.summaryReady, false);
  assert.equal(changed.feedback, 'not_quoted');
  const staleFeedback = await agent.post(`/api/conversations/${conversation.id}/feedback`).send({ feedback: 'accepted', version: 3 });
  assert.equal(staleFeedback.status, 409);
});
