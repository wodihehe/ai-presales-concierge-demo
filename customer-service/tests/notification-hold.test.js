import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { notificationWorker, queueLead } from '../server/notifications.js';

// Synthetic data, temporary SQLite stores and mock transports only. No live
// configuration, customer records, model calls or enterprise messages are used.
const profile = {
  project: '合成测试：资料问答助手', scenario: '员工查询资料', problem: '查找资料耗时',
  features: ['搜索已审核资料', '回答附带资料来源'], inputs: '合成资料文件',
  outputs: '有资料来源的回答', integrations: '暂无系统对接', budget: '', timeline: '',
};
const success = () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'concierge-notification-hold-'));
  let store = openStore(dir);
  const settings = store.settings();
  settings.wecom.webhook = 'https://notification-mock.example.test/webhook';
  store.saveSettings(settings);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; },
    reopen(options) { store.close(); store = openStore(dir, options); return store; },
  };
}
function createLead(store, { multipart = false } = {}) {
  const conversation = store.createConversation('synthetic-hold-owner');
  Object.assign(conversation, {
    profile: structuredClone(profile), summaryReady: true, summaryConfirmed: true,
    summaryVersion: 4, quote: { min: 12000, max: 18000, currency: 'CNY', version: 4 },
    feedback: 'accepted', knowledgeStatus: 'quoted',
    contact: { email: 'synthetic-hold-customer@example.test', consent: true },
  });
  store.saveConversation(conversation);
  assert.equal(queueLead(store, conversation), true);
  const job = store.notifications(conversation.id)[0];
  if (multipart) {
    Object.assign(job, {
      formatVersion: 2,
      renderedParts: [
        '【合成冻结通知 1/3】资料问答助手，需求已确认。',
        '【合成冻结通知 2/3】旧参考价格：12000–18000 CNY，最终待人工确认。',
        '【合成冻结通知 3/3】联系：synthetic-hold-customer@example.test',
      ],
    });
    store.saveNotification(job);
  }
  return { conversation, job };
}
function hold(store, conversationId, token = 'synthetic-analysis-token') {
  store.db.prepare('INSERT INTO notification_holds(conversation_id,token) VALUES(?,?)').run(conversationId, token);
}
function release(store, conversationId, token = 'synthetic-analysis-token') {
  store.db.prepare('DELETE FROM notification_holds WHERE conversation_id=? AND token=?').run(conversationId, token);
}
function held(store, conversationId) {
  return !!store.db.prepare('SELECT 1 FROM notification_holds WHERE conversation_id=?').get(conversationId);
}
function readJob(store, conversationId, jobId) {
  return store.notifications(conversationId).find(item => item.id === jobId);
}

test('analysis hold prevents dispatch and retries until its matching token releases it', async t => {
  const { store } = setup(t);
  const { conversation, job } = createLead(store);
  hold(store, conversation.id);
  const delivered = [];
  const tick = notificationWorker(store, { fetchImpl: async (_url, options) => {
    delivered.push(JSON.parse(options.body).text.content);
    return success();
  } });
  await tick();
  await tick();
  assert.deepEqual(delivered, []);
  assert.equal(readJob(store, conversation.id, job.id).attempts, 0);
  assert.equal(readJob(store, conversation.id, job.id).status, 'pending');
  release(store, conversation.id, 'another-analysis-token');
  await tick();
  assert.equal(held(store, conversation.id), true);
  assert.deepEqual(delivered, []);
  release(store, conversation.id);
  await tick();
  assert.equal(delivered.length, 1);
  assert.equal(readJob(store, conversation.id, job.id).status, 'sent');
  await tick();
  assert.equal(delivered.length, 1, 'release must not create or resend a duplicate job');
  assert.equal(store.notifications(conversation.id).length, 1);
});

test('hold during an in-flight part retains its successful acknowledgement and resumes at the next part', { timeout: 5000 }, async t => {
  const { store } = setup(t);
  const { conversation, job } = createLead(store, { multipart: true });
  const entered = deferred(), response = deferred();
  const delivered = [];
  const tick = notificationWorker(store, { fetchImpl: async (_url, options) => {
    delivered.push(JSON.parse(options.body).text.content);
    if (delivered.length === 1) { entered.resolve(); await response.promise; }
    return success();
  } });
  const running = tick();
  try { await entered.promise; hold(store, conversation.id); }
  finally { response.resolve(); }
  await running;
  const suspended = readJob(store, conversation.id, job.id);
  assert.deepEqual(delivered, job.renderedParts.slice(0, 1));
  assert.equal(suspended.sentParts, 1, 'an already-dispatched success is persisted during the hold');
  assert.equal(suspended.status, 'pending');
  assert.deepEqual(suspended.renderedParts, job.renderedParts);
  assert.equal(held(store, conversation.id), true, 'saving delivery progress cannot remove the independent gate');
  await tick();
  assert.equal(delivered.length, 1);
  release(store, conversation.id);
  await tick();
  assert.deepEqual(delivered, job.renderedParts, 'the acknowledged first part is not sent twice');
  assert.equal(readJob(store, conversation.id, job.id).sentParts, 3);
  assert.equal(readJob(store, conversation.id, job.id).status, 'sent');
});

test('scope change supersedes a held in-flight job and stops all remaining old-price parts', { timeout: 5000 }, async t => {
  const { store } = setup(t);
  const { conversation, job } = createLead(store, { multipart: true });
  const entered = deferred(), response = deferred();
  const delivered = [];
  const tick = notificationWorker(store, { fetchImpl: async (_url, options) => {
    delivered.push(JSON.parse(options.body).text.content);
    if (delivered.length === 1) { entered.resolve(); await response.promise; }
    return success();
  } });
  const running = tick();
  try {
    await entered.promise;
    hold(store, conversation.id);
    conversation.profile.features.push('新增资料审核功能');
    Object.assign(conversation, { summaryVersion: 5, summaryReady: false, summaryConfirmed: false, quote: null, quoteSources: [], feedback: 'not_quoted', knowledgeStatus: 'unavailable' });
    store.saveConversation(conversation);
    store.db.prepare("UPDATE notifications SET status='superseded' WHERE conversation_id=? AND status<>'sent'").run(conversation.id);
    release(store, conversation.id);
    assert.equal(queueLead(store, conversation), true);
  } finally { response.resolve(); }
  await running;
  assert.deepEqual(delivered, job.renderedParts.slice(0, 1), 'already dispatched content cannot be recalled, but later old parts stop');
  assert.equal(readJob(store, conversation.id, job.id).status, 'superseded');
  await tick();
  const jobs = store.notifications(conversation.id);
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find(item => item.id !== job.id).status, 'sent');
  assert.equal(jobs.find(item => item.id !== job.id).payload.quote, null);
  assert.ok(delivered.slice(1).join('').includes('新增资料审核功能'));
  assert.ok(!delivered.slice(1).join('').includes('12000'));
  assert.ok(!delivered.slice(1).includes(job.renderedParts[1]));
  assert.equal(readJob(store, conversation.id, job.id).status, 'superseded');
});

test('reopening after an interrupted analysis cancels all unsent held jobs and never releases an old price', async t => {
  const env = setup(t);
  const { conversation, job } = createLead(env.store, { multipart: true });
  Object.assign(job, { status: 'retrying', attempts: 1, sentParts: 1, nextAt: 0 });
  env.store.saveNotification(job);
  for (const status of ['pending', 'awaiting_configuration', 'failed', 'sent']) {
    const extra = env.store.enqueue(conversation.id, `synthetic-restart-${status}`, job.payload);
    Object.assign(extra, { status, nextAt: 0 });
    env.store.saveNotification(extra);
  }
  Object.assign(conversation, { summaryVersion: 5, summaryReady: false, summaryConfirmed: false, quote: null, quoteSources: [], feedback: 'not_quoted' });
  env.store.saveConversation(conversation);
  hold(env.store, conversation.id);
  env.reopen({ recoverNotificationHolds: true });
  assert.equal(held(env.store, conversation.id), false);
  const recovered = env.store.notifications(conversation.id);
  assert.equal(recovered.filter(item => item.status === 'superseded').length, 4);
  assert.equal(recovered.filter(item => item.status === 'sent').length, 1, 'an already-sent record is not reclassified');
  assert.equal(readJob(env.store, conversation.id, job.id).sentParts, 1);
  assert.deepEqual(readJob(env.store, conversation.id, job.id).renderedParts, job.renderedParts);
  const current = env.store.getConversation(conversation.id);
  assert.equal(current.quote, null);
  assert.equal(current.summaryReady, false);
  assert.equal(current.summaryConfirmed, false);
  let calls = 0;
  const tick = notificationWorker(env.store, { fetchImpl: async () => { calls++; return success(); } });
  await tick();
  assert.equal(calls, 0);
});

test('an in-flight transport failure preserves the analysis gate and retry backoff', { timeout: 5000 }, async t => {
  const { store } = setup(t);
  const { conversation, job } = createLead(store, { multipart: true });
  const entered = deferred(), response = deferred();
  let calls = 0;
  const tick = notificationWorker(store, { fetchImpl: async () => {
    calls++;
    if (calls === 1) { entered.resolve(); await response.promise; throw new Error('Synthetic held request failure'); }
    return success();
  } });
  const running = tick();
  try { await entered.promise; hold(store, conversation.id); }
  finally { response.resolve(); }
  await running;
  const failed = readJob(store, conversation.id, job.id);
  assert.equal(failed.status, 'retrying');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.sentParts || 0, 0);
  assert.ok(failed.nextAt > Date.now());
  assert.equal(held(store, conversation.id), true);
  await tick();
  assert.equal(calls, 1);
  release(store, conversation.id);
  await tick();
  assert.equal(calls, 1, 'releasing a hold does not bypass the stored retry delay');
  store.db.prepare('UPDATE notifications SET next_at=0 WHERE id=?').run(job.id);
  await tick();
  assert.equal(calls, 4);
  assert.equal(readJob(store, conversation.id, job.id).status, 'sent');
});

test('a hold created after worker selection is checked before another selected conversation dispatches', { timeout: 5000 }, async t => {
  const { store } = setup(t);
  const first = createLead(store);
  const second = createLead(store);
  const entered = deferred(), response = deferred();
  const delivered = [];
  const tick = notificationWorker(store, { fetchImpl: async (_url, options) => {
    delivered.push(JSON.parse(options.body).text.content);
    if (delivered.length === 1) { entered.resolve(); await response.promise; }
    return success();
  } });
  const running = tick();
  try { await entered.promise; hold(store, second.conversation.id); }
  finally { response.resolve(); }
  await running;
  assert.equal(delivered.length, 1);
  assert.equal(readJob(store, first.conversation.id, first.job.id).status, 'sent');
  assert.equal(readJob(store, second.conversation.id, second.job.id).status, 'pending');
  assert.equal(readJob(store, second.conversation.id, second.job.id).attempts, 0);
  release(store, second.conversation.id);
  await tick();
  assert.equal(delivered.length, 2);
  assert.equal(readJob(store, second.conversation.id, second.job.id).status, 'sent');
});

test('opening another store for inspection preserves an active hold and all notification state by default', t => {
  const { store } = setup(t);
  const { conversation, job } = createLead(store, { multipart: true });
  Object.assign(job, { status: 'retrying', attempts: 2, sentParts: 1, nextAt: Date.now() + 60000 });
  store.saveNotification(job);
  hold(store, conversation.id);
  const beforeJob = readJob(store, conversation.id, job.id);
  const beforeConversation = store.getConversation(conversation.id);
  const inspection = openStore(store.dir);
  try {
    assert.equal(held(inspection, conversation.id), true);
    assert.deepEqual(readJob(inspection, conversation.id, job.id), beforeJob);
    assert.deepEqual(inspection.getConversation(conversation.id), beforeConversation);
  } finally { inspection.close(); }
  assert.equal(held(store, conversation.id), true);
  assert.deepEqual(readJob(store, conversation.id, job.id), beforeJob);
  assert.deepEqual(store.getConversation(conversation.id), beforeConversation);
});

test('admin retry is rejected during message analysis or a persisted hold without resetting delivery state', { timeout: 6000 }, async t => {
  const { store } = setup(t);
  const entered = deferred(), complete = deferred();
  const { app } = createApp(store, {
    rateLimits: false,
    fetchImpl: async () => { throw new Error('No notification dispatch is expected'); },
    replyFn: async input => {
      entered.resolve(); await complete.promise;
      const latest = input.messages.at(-1), state = input.conversationState;
      return {
        profile: input.profile, ready: true, degraded: false,
        reply: '当前仍是参考区间，最终方案和价格由同事确认。',
        action: { type: 'respond', summaryVersion: state.summaryVersion, quoteVersion: state.quote.version,
          sourceMessageId: latest.id, evidence: latest.content, scopeChanged: false },
      };
    },
  });
  const admin = request.agent(app), visitor = request.agent(app);
  const password = 'synthetic-hold-admin-password-123';
  store.createUser('synthetic-hold-admin', password, 'admin');
  assert.equal((await admin.post('/api/admin/login').send({ username: 'synthetic-hold-admin', password })).status, 200);
  const session = await visitor.get('/api/session');
  assert.equal(session.status, 200);
  const c = store.getConversation(session.body.conversation.id);
  Object.assign(c, { profile: structuredClone(profile), summaryReady: true, summaryConfirmed: true,
    summaryVersion: 4, quote: { min: 12000, max: 18000, currency: 'CNY', version: 4 },
    knowledgeStatus: 'quoted', feedback: 'accepted', contact: { email: 'synthetic-hold-customer@example.test', consent: true } });
  store.saveConversation(c); queueLead(store, c);
  const job = store.notifications(c.id)[0];
  Object.assign(job, { status: 'retrying', attempts: 2, sentParts: 1, nextAt: Date.now() + 60000,
    renderedParts: ['合成冻结第一片', '合成冻结第二片'], formatVersion: 2 });
  store.saveNotification(job);
  const before = readJob(store, c.id, job.id);
  const pending = visitor.post(`/api/conversations/${c.id}/messages`).send({ content: '这个区间是参考价吗？',
    requestId: 'synthetic-held-analysis', summaryVersion: c.summaryVersion }).then(response => response);
  try {
    await entered.promise;
    assert.equal(held(store, c.id), true);
    const blocked = await admin.post(`/api/admin/notifications/${job.id}/retry`);
    assert.equal(blocked.status, 409);
    assert.deepEqual(readJob(store, c.id, job.id), before);
  } finally { complete.resolve(); }
  const finished = await pending;
  assert.equal(finished.status, 200);
  assert.equal(held(store, c.id), false);
  assert.deepEqual(readJob(store, c.id, job.id), before);

  hold(store, c.id, 'persisted-hold-without-in-memory-lock');
  const persistedBlocked = await admin.post(`/api/admin/notifications/${job.id}/retry`);
  assert.equal(persistedBlocked.status, 409, 'the persisted gate is checked even without the local message lock');
  assert.deepEqual(readJob(store, c.id, job.id), before);
  release(store, c.id, 'persisted-hold-without-in-memory-lock');
  const allowed = await admin.post(`/api/admin/notifications/${job.id}/retry`);
  assert.equal(allowed.status, 200);
  const retried = readJob(store, c.id, job.id);
  assert.equal(retried.status, 'pending');
  assert.equal(retried.attempts, 0);
  assert.equal(retried.sentParts, 1);
  assert.deepEqual(retried.renderedParts, before.renderedParts);
});
