import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/store.js';
import { messageParts, notificationWorker, queueLead } from '../server/notifications.js';

// Synthetic payloads, temporary SQLite databases and transport mocks only.
// No live customer records, model calls or enterprise WeChat messages are used.
const profile = {
  project: '合成测试：内部资料问答与审核流程',
  scenario: '员工查阅已审核的企业资料',
  problem: '资料分散，人工查找耗时',
  features: Array.from({ length: 8 }, (_, i) => `功能${i + 1}：${'需要审核的业务内容及使用边界😀'.repeat(28)}`),
  inputs: '已审核的合成 PDF 文件',
  outputs: '附资料来源的回答与待审核清单',
  integrations: '暂不对接现有业务系统',
  budget: '待确认',
  timeline: '待确认',
};
const success = () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 });

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'concierge-notification-retry-'));
  let store = openStore(dir);
  const settings = store.settings();
  settings.wecom.webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-retry-only';
  store.saveSettings(settings);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; },
    reopen() { store.close(); store = openStore(dir); return store; },
  };
}

function createLead(store) {
  const conversation = store.createConversation('synthetic-retry-owner');
  Object.assign(conversation, {
    profile: structuredClone(profile),
    summaryConfirmed: true,
    quote: { min: 12000, max: 18000, currency: 'CNY', version: 1 },
    feedback: 'accepted',
    knowledgeStatus: 'quoted',
    notificationReason: '客户主动请求人工',
    contact: { email: 'synthetic-retry-customer@example.test', consent: true },
  });
  store.saveConversation(conversation);
  assert.equal(queueLead(store, conversation), true);
  return conversation;
}

// Frozen compatibility baseline: the production renderer before the concise
// notification update. Legacy in-flight jobs must retain these exact bytes.
function originalMessageParts(p) {
  const labels = { accepted: '接受参考区间（待人工确认）', too_high: '价格偏高', considering: '待考虑', not_quoted: '尚未报价' };
  const quote = p.quote ? `${p.quote.min}–${p.quote.max} ${p.quote.currency}，最终待人工确认` : '尚未报价，需人工评估';
  const content = [
    `【网站客户咨询】${p.project}`,
    `需求${p.confirmed ? '（客户已确认）' : '（待补充确认）'}：${p.problem || p.scenario || p.project}`,
    `功能：${p.features?.join('；') || '待沟通'}`,
    `输入／输出：${p.inputs || '待沟通'} ／ ${p.outputs || '待沟通'}`,
    `系统对接：${p.integrations || '待沟通'}`,
    `预算／期望时间：${p.budget || '未提供'} ／ ${p.timeline || '未提供'}`,
    `参考报价：${quote}`,
    `客户反馈：${labels[p.feedback] || '尚未报价'}`,
    `联系方式：${[p.contact.phone && '手机 ' + p.contact.phone, p.contact.wechat && '微信 ' + p.contact.wechat, p.contact.email && '邮箱 ' + p.contact.email].filter(Boolean).join('；')}`,
    p.contact.name && `称呼：${p.contact.name}`,
    p.contact.company && `公司：${p.contact.company}`,
    p.latestCustomerNote && `客户最新补充（原文，待人工核实）：${p.latestCustomerNote}`,
    `跟进原因：${p.reason}`,
    '说明：已获客户联系意愿；方案及报价待人工最终确认。',
  ].filter(Boolean).join('\n');
  const parts = [];
  let part = '';
  for (const character of content) {
    if (Buffer.byteLength(part + character) > 1800) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  return parts.map((value, i) => parts.length > 1 ? `【项目通知 ${i + 1}/${parts.length}】\n${value}` : value);
}

test('multipart retries persist rendered content before dispatch and resume only unsent parts after reopening SQLite', async t => {
  const env = setup(t);
  const conversation = createLead(env.store);
  const original = env.store.notifications(conversation.id)[0];
  const expected = messageParts(original.payload);
  assert.ok(expected.length > 2, 'fixture must exercise multiple remaining parts');
  assert.ok(expected.every(part => Buffer.byteLength(part) < 2048));
  const firstAttempts = [];
  const tick = notificationWorker(env.store, { fetchImpl: async (_url, options) => {
    const persisted = env.store.notifications(conversation.id)[0];
    assert.equal(persisted.formatVersion, 2);
    assert.deepEqual(persisted.renderedParts, expected, 'freeze all text before the first network request');
    firstAttempts.push(JSON.parse(options.body).text.content);
    if (firstAttempts.length === 2) throw new Error('Synthetic transport failure');
    return success();
  } });
  await tick();
  assert.deepEqual(firstAttempts, expected.slice(0, 2));
  const failed = env.store.notifications(conversation.id)[0];
  assert.equal(failed.status, 'retrying');
  assert.equal(failed.sentParts, 1);
  assert.equal(failed.attempts, 1);
  assert.deepEqual(failed.renderedParts, expected);

  env.reopen();
  const recovered = env.store.notifications(conversation.id)[0];
  assert.deepEqual(recovered.renderedParts, expected, 'frozen text must survive process/database reopening');
  assert.equal(recovered.sentParts, 1);
  env.store.db.prepare('UPDATE notifications SET next_at=0 WHERE id=?').run(original.id);
  const continued = [];
  const resume = notificationWorker(env.store, { fetchImpl: async (_url, options) => {
    continued.push(JSON.parse(options.body).text.content);
    return success();
  } });
  await resume();
  assert.deepEqual(continued, expected.slice(1));
  const completed = env.store.notifications(conversation.id)[0];
  assert.equal(completed.id, original.id);
  assert.equal(completed.status, 'sent');
  assert.equal(completed.sentParts, expected.length);
  assert.equal(completed.attempts, 2);
  assert.deepEqual(completed.renderedParts, expected);
  assert.equal(env.store.notifications(conversation.id).length, 1);
});

test('an old partially sent task rebuilds the original Unicode byte slices and finishes in legacy format', async t => {
  const { store } = setup(t);
  const conversation = createLead(store);
  const original = store.notifications(conversation.id)[0];
  const expected = originalMessageParts(original.payload);
  assert.ok(expected.length > 2);
  assert.notDeepEqual(expected, messageParts(original.payload), 'old and new formats must differ for this fixture');
  Object.assign(original, { status: 'retrying', sentParts: 1, attempts: 1, nextAt: 0 });
  delete original.renderedParts;
  delete original.formatVersion;
  store.saveNotification(original);
  const delivered = [];
  const tick = notificationWorker(store, { fetchImpl: async (_url, options) => {
    const persisted = store.notifications(conversation.id)[0];
    assert.equal(persisted.formatVersion, 1);
    assert.deepEqual(persisted.renderedParts, expected);
    delivered.push(JSON.parse(options.body).text.content);
    return success();
  } });
  await tick();
  assert.deepEqual(delivered, expected.slice(1), 'do not resend the old first part or skip a new-format boundary');
  assert.ok(delivered.every(part => !part.includes('\uFFFD')));
  assert.ok(delivered.every(part => Buffer.byteLength(part) < 2048));
  const completed = store.notifications(conversation.id)[0];
  assert.equal(completed.status, 'sent');
  assert.equal(completed.sentParts, expected.length);
  assert.equal(completed.formatVersion, 1);
  assert.deepEqual(completed.renderedParts, expected);
  assert.equal(store.notifications(conversation.id).length, 1);
});

test('an unsent old task adopts the concise format in place without changing business deduplication', async t => {
  const { store } = setup(t);
  const conversation = createLead(store);
  const original = store.notifications(conversation.id)[0];
  Object.assign(original, { status: 'awaiting_configuration', sentParts: 0, nextAt: 0 });
  delete original.renderedParts;
  delete original.formatVersion;
  store.saveNotification(original);
  const expected = messageParts(original.payload);
  assert.notDeepEqual(expected, originalMessageParts(original.payload));
  const delivered = [];
  const tick = notificationWorker(store, { fetchImpl: async (_url, options) => {
    const persisted = store.notifications(conversation.id)[0];
    assert.equal(persisted.formatVersion, 2);
    assert.deepEqual(persisted.renderedParts, expected);
    delivered.push(JSON.parse(options.body).text.content);
    return success();
  } });
  await tick();
  assert.deepEqual(delivered, expected);
  const completed = store.notifications(conversation.id)[0];
  assert.equal(completed.id, original.id);
  assert.equal(completed.fingerprint, original.fingerprint);
  assert.equal(completed.status, 'sent');
  assert.deepEqual(completed.payload, original.payload);
  assert.equal(queueLead(store, conversation), false, 'presentation metadata must not make identical business facts new');
  assert.equal(store.notifications(conversation.id).length, 1);
});

test('a previously frozen task keeps its exact saved text when the current renderer would produce different parts', async t => {
  const { store } = setup(t);
  const conversation = createLead(store);
  const original = store.notifications(conversation.id)[0];
  const frozen = [
    '【合成冻结通知 1/3】既有版本已经发送的项目摘要',
    '【合成冻结通知 2/3】保留上一部署版本的原始字节与段落。\n参考报价：12000–18000 CNY，待人工确认',
    '【合成冻结通知 3/3】联系方式：synthetic-retry-customer@example.test',
  ];
  assert.notDeepEqual(frozen, messageParts(original.payload));
  Object.assign(original, { status: 'retrying', sentParts: 1, attempts: 1, nextAt: 0, formatVersion: 2, renderedParts: frozen });
  store.saveNotification(original);
  const delivered = [];
  const tick = notificationWorker(store, { fetchImpl: async (_url, options) => {
    delivered.push(JSON.parse(options.body).text.content);
    return success();
  } });
  await tick();
  assert.deepEqual(delivered, frozen.slice(1), 'saved parts are authoritative across renderer upgrades');
  const completed = store.notifications(conversation.id)[0];
  assert.equal(completed.status, 'sent');
  assert.equal(completed.sentParts, frozen.length);
  assert.deepEqual(completed.renderedParts, frozen);
});
