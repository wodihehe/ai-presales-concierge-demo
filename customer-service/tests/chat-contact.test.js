import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { generateReply } from '../server/intelligence.js';
import { queueLead } from '../server/notifications.js';

// These deliberately scripted semantic outputs test the public business flow,
// not model understanding. Every contact, quote, database and transport is
// synthetic; the notification transport never opens a network connection.
const profile = {
  project: '合成商品素材项目', scenario: '店铺运营', problem: '',
  features: ['生成商品主图', '生成详情页文案'], inputs: '商品照片和参数表',
  outputs: '主图和详情长图', integrations: '不自动发布', budget: '', timeline: '',
};
const syntheticEmail = 'chat-followup@example.test';
const fakeClaim = '联系方式已经为你记下，同事已经收到通知并会联系你。';

function body(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
function latestOf(input) { return input.messages.findLast(message => message.role === 'user'); }
function semanticReply(input, { type = 'respond', nextProfile, contactAction, reply = '收到你的消息啦。' } = {}) {
  const latest = latestOf(input), state = input.conversationState;
  return {
    profile: structuredClone(nextProfile || input.profile), ready: state.summaryReady,
    degraded: false, reply,
    action: {
      type, summaryVersion: state.summaryVersion, quoteVersion: state.quote?.version ?? null,
      sourceMessageId: latest.id, evidence: latest.content, scopeChanged: type === 'continue',
    },
    ...(contactAction !== undefined ? { contactAction } : {}),
  };
}
function saveAction(input, values = {}, consent = 'granted', source = latestOf(input)) {
  const latest = latestOf(input);
  return {
    type: 'save', sourceMessageId: latest.id, evidence: latest.content, consent,
    fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
      { value, sourceMessageId: source.id, quote: source.content }])),
  };
}
function withdrawAction(input) {
  const latest = latestOf(input);
  return { type: 'withdraw', sourceMessageId: latest.id, evidence: latest.content };
}
function setup(t, { configured = true, deliveryFails = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'concierge-chat-contact-'));
  const store = openStore(dir), replies = [], calls = { model: [], delivery: [] };
  if (configured) { const settings = store.settings(); settings.wecom.webhook = 'https://notifications.example.test/synthetic'; store.saveSettings(settings); }
  const application = createApp(store, {
    rateLimits: false,
    replyFn: async input => {
      calls.model.push(structuredClone(input));
      assert.ok(replies.length, 'each semantic decision must have an explicit test script');
      return replies.shift()(input);
    },
    quoteFn: async ({ version }) => ({ status: 'quoted',
      quote: { min: 12000, max: 18000, currency: 'CNY', version, note: '合成价格，仅用于回归。' }, sources: ['synthetic-case'] }),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://notifications.example.test/synthetic');
      calls.delivery.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ errcode: deliveryFails ? 500 : 0 }), { headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...application, store, calls, queue: script => replies.push(script) };
}
async function visitor(env, { confirmed = true, quoted = false, empty = false } = {}) {
  const agent = request.agent(env.app), initial = body(await agent.get('/api/session')).conversation;
  const c = env.store.getConversation(initial.id);
  if (!empty) {
    c.profile = structuredClone(profile); c.summaryVersion = 7; c.summaryReady = true; c.summaryConfirmed = confirmed;
    c.handoff = confirmed && !quoted; c.knowledgeStatus = quoted ? 'quoted' : 'not_configured';
    c.quote = quoted ? { min: 12000, max: 18000, currency: 'CNY', version: 7, note: '合成参考价格。' } : null;
    c.messages.push({ id: 'synthetic-followup-invitation', role: 'assistant',
      content: '需要同事评估方案。可以留下自己的手机号、微信号或邮箱，用于本次项目跟进，并通知公司内部业务群。',
      createdAt: new Date().toISOString(), attachments: [] });
    env.store.saveConversation(c);
  }
  return { agent, id: c.id, url: `/api/conversations/${c.id}`, serial: 0 };
}
async function send(env, client, content, script, overrides = {}) {
  env.queue(script);
  const summaryVersion = env.store.getConversation(client.id).summaryVersion;
  return client.agent.post(`${client.url}/messages`).send({ content, summaryVersion,
    requestId: `synthetic-chat-${++client.serial}`, ...overrides });
}
function activeNotifications(env, client) { return env.store.notifications(client.id).filter(item => item.status !== 'superseded'); }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function assertNoFalseReceipt(c) {
  assert.notEqual(c.messages.at(-1).content, fakeClaim, 'a model assertion is not proof that a contact was saved or delivered');
  assert.doesNotMatch(c.messages.at(-1).content, /已经为你记下|已经收到通知|已通知同事/);
}

test('chat phone, WeChat or email are persisted, queued and sent with the project through mocked delivery', async t => {
  for (const [method, value] of [['phone', '+1 (202) 555-0100'], ['wechat', 'synthetic_chat_user'], ['email', syntheticEmail]]) {
    await t.test(method, async t => {
      const env = setup(t), client = await visitor(env);
      const beforeContact = env.store.getConversation(client.id);
      beforeContact.contactNeedsReview = false; env.store.saveConversation(beforeContact);
      const result = body(await send(env, client, `${value}，这是我自己的联系方式，可以用于跟进这个项目。`,
        input => semanticReply(input, { contactAction: saveAction(input, { [method]: value }), reply: fakeClaim }))).conversation;
      const stored = env.store.getConversation(client.id);
      assert.equal(stored.contact[method], value); assert.equal(stored.contact.consent, true);
      assert.equal(result.contactSubmitted, true); assert.equal(result.contact, undefined);
      assert.equal(result.contactEvidence, undefined, 'private evidence is not part of the visitor contract');
      assert.equal(result.summaryVersion, 7); assert.equal(result.summaryConfirmed, true);
      assert.equal(result.followupStatus, 'pending'); assert.equal(activeNotifications(env, client).length, 1);
      assert.equal(activeNotifications(env, client)[0].status, 'pending');
      assert.equal(activeNotifications(env, client)[0].payload.contactEvidence, undefined);
      assert.notEqual(result.messages.at(-1).content, fakeClaim);
      assert.equal(env.calls.delivery.length, 0, 'HTTP response records a queued handoff, not completed group delivery');
      await env.tick();
      assert.equal(activeNotifications(env, client)[0].status, 'sent');
      const sent = env.calls.delivery.map(item => item.text.content).join('\n');
      assert.ok(sent.includes(profile.project)); assert.ok(sent.includes(value));
      assert.ok(sent.includes('生成商品主图')); assert.ok(sent.includes('生成详情页文案'));
      assert.ok(result.notifications.every(item => !Object.hasOwn(item, 'payload')));
    });
  }
});

test('unknown consent saves a contact without notifying, and later clear permission uses existing contact', async t => {
  const env = setup(t), client = await visitor(env);
  const first = body(await send(env, client, `我的邮箱是 ${syntheticEmail}，我还想了解一下后续流程。`,
    input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }, 'unknown') }))).conversation;
  assert.equal(first.contactSubmitted, false); assert.equal(env.store.getConversation(client.id).contact.email, syntheticEmail);
  assert.equal(env.store.getConversation(client.id).contact.consent, false);
  assert.equal(env.store.notifications(client.id).length, 0);
  const second = body(await send(env, client, '可以，请让同事通过刚才的邮箱联系我。', input => {
    assert.equal(input.conversationState.contactAvailable, true);
    assert.equal(input.conversationState.contactConsented, false);
    return semanticReply(input, { contactAction: saveAction(input) });
  })).conversation;
  assert.equal(second.contactSubmitted, true); assert.equal(activeNotifications(env, client).length, 1);
  assert.equal(env.store.getConversation(client.id).contact.email, syntheticEmail);
});

test('grounded user contact from an earlier message can be authorized now', async t => {
  const env = setup(t), client = await visitor(env);
  body(await send(env, client, `这是资料中的联系邮箱 ${syntheticEmail}，请先解释一下使用用途。`, input => semanticReply(input)));
  const source = env.store.getConversation(client.id).messages.find(message => message.role === 'user');
  const result = body(await send(env, client, '那就是我的邮箱，可以让同事用它跟进这次项目。',
    input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }, 'granted', source) }))).conversation;
  assert.equal(result.contactSubmitted, true); assert.equal(env.store.getConversation(client.id).contact.email, syntheticEmail);
  assert.equal(activeNotifications(env, client).length, 1);
});

test('semantic withdrawal cancels unsent jobs and renewed permission queues an unchanged contact again', async t => {
  const env = setup(t), client = await visitor(env);
  body(await send(env, client, `请用 ${syntheticEmail} 联系我。`, input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) })));
  const withdrawn = body(await send(env, client, '我现在不希望团队再主动找我讨论，请先暂停。',
    input => semanticReply(input, { contactAction: withdrawAction(input) }))).conversation;
  assert.equal(withdrawn.contactSubmitted, false); assert.equal(env.store.getConversation(client.id).contact.consent, false);
  assert.equal(activeNotifications(env, client).length, 0); await env.tick(); assert.equal(env.calls.delivery.length, 0);
  const resumed = body(await send(env, client, '情况有变化，可以继续通过我之前的邮箱跟进了。',
    input => semanticReply(input, { contactAction: saveAction(input) }))).conversation;
  assert.equal(resumed.contactSubmitted, true); assert.equal(activeNotifications(env, client).length, 1);
  await env.tick(); assert.equal(env.calls.delivery.length, 1);
});

test('renewed consent after an already sent handoff creates one fresh notification for chat and form', async t => {
  for (const channel of ['chat', 'form']) await t.test(channel, async t => {
    const env = setup(t), client = await visitor(env);
    if (channel === 'chat') {
      body(await send(env, client, `请用 ${syntheticEmail} 联系我。`,
        input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) })));
    } else body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
    await env.tick();
    const original = env.store.notifications(client.id)[0];
    assert.equal(original.status, 'sent'); assert.equal(env.calls.delivery.length, 1);
    if (channel === 'chat') {
      body(await send(env, client, '我现在不希望团队再主动找我讨论，请先暂停。',
        input => semanticReply(input, { contactAction: withdrawAction(input) })));
    } else body(await client.agent.post(`${client.url}/contact`).send({ consent: false }));
    assert.equal(env.store.getConversation(client.id).contact.consent, false);
    assert.equal(env.store.notifications(client.id)[0].status, 'sent', 'withdrawal cannot erase an already sent notification');
    await env.tick(); assert.equal(env.calls.delivery.length, 1);
    const resumed = channel === 'chat'
      ? body(await send(env, client, '情况有变化，可以继续通过我之前的邮箱跟进了。',
        input => semanticReply(input, { contactAction: saveAction(input) }))).conversation
      : body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true })).conversation;
    assert.equal(resumed.contactSubmitted, true);
    const renewed = env.store.notifications(client.id);
    assert.equal(renewed.length, 2); assert.equal(renewed[0].status, 'pending'); assert.equal(renewed[1].status, 'sent');
    assert.notEqual(renewed[0].id, original.id);
    assert.deepEqual(renewed[0].payload, original.payload, 'renewed consent is meaningful even when the business payload is identical');
    await env.tick(); assert.equal(env.calls.delivery.length, 2);
    if (channel === 'chat') {
      body(await send(env, client, '对，继续通过刚才的邮箱联系我就行。',
        input => semanticReply(input, { contactAction: saveAction(input) })));
    } else body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
    await env.tick(); assert.equal(env.calls.delivery.length, 2);
    assert.equal(env.store.notifications(client.id).length, 2, 'continuous repeated permission must still deduplicate');
  });
});

test('updating one contact method preserves the other valid contact fields', async t => {
  const env = setup(t), client = await visitor(env);
  body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, wechat: 'synthetic_previous',
    name: '合成访客', company: '合成示例公司', consent: true }));
  const result = body(await send(env, client, '以后改用 synthetic_revised 联系我。',
    input => semanticReply(input, { contactAction: saveAction(input, { wechat: 'synthetic_revised' }) }))).conversation;
  const contact = env.store.getConversation(client.id).contact;
  assert.equal(contact.email, syntheticEmail); assert.equal(contact.name, '合成访客'); assert.equal(contact.company, '合成示例公司');
  assert.equal(contact.wechat, 'synthetic_revised'); assert.equal(contact.consent, true); assert.equal(result.summaryVersion, 7);
  assert.equal(activeNotifications(env, client).length, 1);
});

test('duplicate message retry and repeated contact submission do not produce duplicate handoffs', async t => {
  const env = setup(t), client = await visitor(env);
  const content = `我的邮箱是 ${syntheticEmail}，请同事联系我。`;
  const first = body(await send(env, client, content, input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) }),
    { requestId: 'synthetic-idempotent-contact' })).conversation;
  const modelCount = env.calls.model.length;
  body(await client.agent.post(`${client.url}/messages`).send({ content, summaryVersion: first.summaryVersion, requestId: 'synthetic-idempotent-contact' }));
  assert.equal(env.calls.model.length, modelCount); assert.equal(env.store.notifications(client.id).length, 1);
  await env.tick(); assert.equal(env.calls.delivery.length, 1);
  body(await send(env, client, `还是刚才的 ${syntheticEmail}，谢谢。`,
    input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) })));
  assert.equal(env.store.notifications(client.id).length, 1); await env.tick(); assert.equal(env.calls.delivery.length, 1);
});

test('contact-only message preserves a confirmed quote and cannot accept it or mark the lead won', async t => {
  const env = setup(t), client = await visitor(env, { quoted: true });
  const original = structuredClone(env.store.getConversation(client.id).quote);
  const result = body(await send(env, client, `可以通过 ${syntheticEmail} 向我说明方案。`,
    input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) }))).conversation;
  assert.deepEqual(result.quote, original); assert.equal(result.summaryVersion, 7); assert.equal(result.summaryConfirmed, true);
  assert.equal(result.feedback, 'not_quoted'); assert.equal(result.followupStatus, 'pending');
});

test('scope revision plus contact invalidates the old quote before queueing the revised project', async t => {
  const env = setup(t), client = await visitor(env, { quoted: true });
  const next = { ...profile, features: [...profile.features, '生成短视频'], outputs: '主图、详情长图和短视频' };
  const result = body(await send(env, client, `还要新增生成短视频，请用 ${syntheticEmail} 联系我确认。`,
    input => semanticReply(input, { type: 'continue', nextProfile: next, contactAction: saveAction(input, { email: syntheticEmail }) }))).conversation;
  assert.equal(result.quote, null); assert.equal(result.summaryConfirmed, false); assert.equal(result.summaryVersion, 8);
  const jobs = activeNotifications(env, client); assert.equal(jobs.length, 1); assert.equal(jobs[0].payload.quote, null);
  assert.equal(jobs[0].payload.confirmed, false); assert.ok(jobs[0].payload.features.includes('生成短视频'));
  await env.tick(); const text = env.calls.delivery.map(item => item.text.content).join('\n');
  assert.ok(text.includes('生成短视频')); assert.ok(text.includes(syntheticEmail)); assert.doesNotMatch(text, /12000|18000/);
});

test('requesting a human in the same message cannot bypass chat contact registration', async t => {
  const env = setup(t), client = await visitor(env);
  const result = body(await send(env, client, `我的邮箱是 ${syntheticEmail}，请转人工继续联系我。`,
    input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) }))).conversation;
  assert.equal(env.calls.model.length, 1); assert.equal(result.contactSubmitted, true);
  assert.equal(result.summaryVersion, 7); assert.equal(activeNotifications(env, client).length, 1);
});

test('invalid contact shapes, formats and sources never execute or preserve model success prose', async t => {
  const cases = [
    ['invalid phone', input => saveAction(input, { phone: '+12' }), '+12 是我的电话，请联系我。'],
    ['invalid email', input => saveAction(input, { email: 'invalid.example.test' }), '请用 invalid.example.test 联系我。'],
    ['invalid WeChat', input => saveAction(input, { wechat: 'x' }), '我的微信是 x，请联系我。'],
    ['forged value', input => saveAction(input, { email: 'not-present@example.test' })],
    ['unknown source', input => { const a = saveAction(input, { email: syntheticEmail }); a.fields.email.sourceMessageId = 'nonexistent-user'; return a; }],
    ['assistant source', input => { const a = saveAction(input, { email: syntheticEmail }); a.fields.email.sourceMessageId = 'synthetic-followup-invitation'; return a; }],
    ['quote omits the value', input => { const a = saveAction(input, { email: syntheticEmail }); a.fields.email.quote = '请联系我'; return a; }],
    ['quote not in source', input => { const a = saveAction(input, { email: syntheticEmail }); a.fields.email.quote = `编造来源 ${syntheticEmail} 这是额外编造的文字`; return a; }],
    ['wrong action source', input => ({ ...saveAction(input, { email: syntheticEmail }), sourceMessageId: 'previous-user' })],
    ['partial consent evidence', input => ({ ...saveAction(input, { email: syntheticEmail }), evidence: '请联系我' })],
    ['invented consent evidence', input => ({ ...saveAction(input, { email: syntheticEmail }), evidence: '同意员工联系并且马上安排' })],
    ['nonenum consent', input => ({ ...saveAction(input, { email: syntheticEmail }), consent: true })],
    ['empty fields without existing contact', input => saveAction(input)],
    ['unknown execution permission', input => ({ ...saveAction(input, { email: syntheticEmail }), dispatchNow: true })],
    ['false action', () => false],
  ];
  for (const [name, makeAction, content = `请用 ${syntheticEmail} 联系我。`] of cases) await t.test(name, async t => {
    const env = setup(t), client = await visitor(env);
    const result = body(await send(env, client, content,
      input => semanticReply(input, { contactAction: makeAction(input), reply: fakeClaim }))).conversation;
    assert.equal(result.contactSubmitted, false); assert.equal(env.store.getConversation(client.id).contact, null);
    assert.equal(env.store.notifications(client.id).length, 0); assertNoFalseReceipt(result);
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM notification_holds').get().n, 0);
  });
});

test('invalid contact execution does not discard a separately valid requirement correction', async t => {
  const env = setup(t), client = await visitor(env, { quoted: true });
  const next = { ...profile, features: [...profile.features, '导出文案表格'] };
  const result = body(await send(env, client, '新增导出文案表格，联系邮箱是 invalid.example.test。',
    input => semanticReply(input, { type: 'continue', nextProfile: next,
      contactAction: saveAction(input, { email: 'invalid.example.test' }), reply: fakeClaim }))).conversation;
  assert.ok(result.profile.features.includes('导出文案表格')); assert.equal(result.quote, null); assert.equal(result.summaryConfirmed, false);
  assert.equal(result.contactSubmitted, false); assert.equal(env.store.notifications(client.id).length, 0); assertNoFalseReceipt(result);
});

test('degraded model output cannot authorize a contact even if it contains a plausible action', async t => {
  const env = setup(t), client = await visitor(env);
  const result = body(await send(env, client, `我的邮箱 ${syntheticEmail}，请联系。`, input => ({
    ...semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }), reply: fakeClaim }), degraded: true,
  }))).conversation;
  assert.equal(result.contactSubmitted, false); assert.equal(env.store.getConversation(client.id).contact, null);
  assert.equal(env.store.notifications(client.id).length, 0); assertNoFalseReceipt(result);
});

test('no project keeps contact pending rather than notifying an invented lead', async t => {
  const env = setup(t), client = await visitor(env, { empty: true });
  const result = body(await send(env, client, `先留一个邮箱 ${syntheticEmail}，可以联系我。`,
    input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) }))).conversation;
  assert.equal(result.profile.project, ''); assert.equal(env.store.notifications(client.id).length, 0);
  assert.doesNotMatch(result.messages.at(-1).content, /已通知|已经收到通知/);
});

test('missing Webhook and rejected delivery expose actual queue states instead of fake success', async t => {
  for (const options of [{ configured: false, expected: 'awaiting_configuration' }, { deliveryFails: true, expected: 'retrying' }]) {
    await t.test(options.expected, async t => {
      const env = setup(t, options), client = await visitor(env);
      const result = body(await send(env, client, `请同事通过 ${syntheticEmail} 联系我。`,
        input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }), reply: fakeClaim }))).conversation;
      assert.equal(result.contactSubmitted, true); assert.notEqual(result.messages.at(-1).content, fakeClaim);
      assert.doesNotMatch(result.messages.at(-1).content, /已通知|已经收到通知/);
      await env.tick(); assert.equal(activeNotifications(env, client)[0].status, options.expected);
      const current = body(await client.agent.get(client.url)).conversation;
      assert.equal(current.notifications[0].status, options.expected);
    });
  }
});

test('ordinary answers and confirmations cannot invent contact consent', async t => {
  const env = setup(t), client = await visitor(env);
  const result = body(await send(env, client, '好的，需求就是这些，谢谢。', input => semanticReply(input))).conversation;
  assert.equal(result.contactSubmitted, false); assert.equal(env.store.getConversation(client.id).contact, null);
  assert.equal(env.store.notifications(client.id).length, 0);
});

test('an unknown follow-up purpose suspends existing consent and pending jobs until permission is renewed', async t => {
  const env = setup(t), client = await visitor(env);
  body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
  const first = body(await send(env, client, '我需要再确认一下资料用途，先和我解释清楚。',
    input => semanticReply(input, { contactAction: saveAction(input, {}, 'unknown') }))).conversation;
  assert.equal(first.contactSubmitted, false); assert.equal(env.store.getConversation(client.id).contact.consent, false);
  assert.equal(activeNotifications(env, client).length, 0); await env.tick(); assert.equal(env.calls.delivery.length, 0);
  const second = body(await send(env, client, '明白了，可以继续联系我跟进这个项目。',
    input => semanticReply(input, { contactAction: saveAction(input) }))).conversation;
  assert.equal(second.contactSubmitted, true); assert.equal(activeNotifications(env, client).length, 1);
});

test('null contact action is a valid no-op, not authorization or proof of registration', async t => {
  const env = setup(t), client = await visitor(env);
  const result = body(await send(env, client, '谢谢，我再考虑一下。',
    input => semanticReply(input, { contactAction: null, reply: '没问题，有新的想法可以继续聊。' }))).conversation;
  assert.equal(result.contactSubmitted, false); assert.equal(env.store.getConversation(client.id).contact, null);
  assert.equal(env.store.notifications(client.id).length, 0);
  assert.equal(result.messages.at(-1).content, '没问题，有新的想法可以继续聊。');
});

test('analysis holds pending delivery until a revised contact has been saved, then only the new contact is sent', async t => {
  const env = setup(t), client = await visitor(env, { quoted: true });
  body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
  const entered = deferred(), release = deferred(), replacement = 'changed-chat@example.test';
  const pending = send(env, client, `请改成 ${replacement} 联系我，之前的邮箱不用了。`, async input => {
    entered.resolve(); await release.promise;
    return semanticReply(input, { contactAction: saveAction(input, { email: replacement }) });
  });
  await entered.promise;
  assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM notification_holds').get().n, 1);
  await env.tick(); assert.equal(env.calls.delivery.length, 0);
  assert.equal((await client.agent.post(`${client.url}/contact`).send({ email: 'parallel-update@example.test', consent: true })).status, 409);
  release.resolve(); const result = body(await pending).conversation;
  assert.equal(result.summaryVersion, 7); assert.equal(result.quote.version, 7);
  assert.equal(env.store.getConversation(client.id).contact.email, replacement);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM notification_holds').get().n, 0);
  await env.tick();
  const sent = env.calls.delivery.map(item => item.text.content).join('\n');
  assert.ok(sent.includes(replacement)); assert.ok(!sent.includes(syntheticEmail));
  assert.equal(activeNotifications(env, client).length, 1);
});

test('deleting the conversation during contact analysis prevents resurrection or notification', async t => {
  const env = setup(t), client = await visitor(env), entered = deferred(), release = deferred();
  const pending = send(env, client, `请用 ${syntheticEmail} 联系我。`, async input => {
    entered.resolve(); await release.promise;
    return semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) });
  });
  await entered.promise; env.store.deleteConversation(client.id); release.resolve();
  const result = await pending; assert.equal(result.status, 410);
  assert.equal(env.store.getConversation(client.id), null); assert.equal(env.store.notifications(client.id).length, 0);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM notification_holds').get().n, 0);
  await env.tick(); assert.equal(env.calls.delivery.length, 0);
});

test('stale browser versions are rejected before contact interpretation or storage', async t => {
  const env = setup(t), client = await visitor(env);
  const response = await client.agent.post(`${client.url}/messages`).send({ content: `请用 ${syntheticEmail} 联系我。`,
    summaryVersion: 6, requestId: 'synthetic-stale-contact' });
  assert.equal(response.status, 409); assert.equal(env.calls.model.length, 0);
  assert.equal(env.store.getConversation(client.id).contact, null); assert.equal(env.store.notifications(client.id).length, 0);
});

test('repeating a contact before requirement confirmation does not create a new raw-note notification', async t => {
  const env = setup(t), client = await visitor(env, { confirmed: false });
  body(await send(env, client, `我的邮箱 ${syntheticEmail}，请同事跟进。`,
    input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) })));
  await env.tick(); assert.equal(env.calls.delivery.length, 1);
  body(await send(env, client, `邮箱还是 ${syntheticEmail}，刚才的资料可以继续使用。`,
    input => semanticReply(input, { contactAction: saveAction(input, { email: syntheticEmail }) })));
  assert.equal(env.store.notifications(client.id).length, 1); await env.tick(); assert.equal(env.calls.delivery.length, 1);
});

test('shared form contact handling still queues a changed project when contact information is unchanged', async t => {
  const env = setup(t), client = await visitor(env);
  body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
  await env.tick(); assert.equal(env.calls.delivery.length, 1);
  const nextProject = '合成企业资料问答项目';
  const result = body(await client.agent.post(`${client.url}/contact`).send({ project: nextProject, email: syntheticEmail, consent: true })).conversation;
  assert.equal(result.profile.project, nextProject); assert.equal(result.summaryConfirmed, false); assert.equal(result.quote, null);
  const latest = env.store.notifications(client.id)[0];
  assert.equal(latest.payload.project, nextProject); assert.equal(latest.status, 'pending');
  await env.tick(); assert.equal(env.calls.delivery.length, 2);
  assert.ok(env.calls.delivery.at(-1).text.content.includes(nextProject));
});

test('valid saved contact after a rejected update sends the revised scope instead of reusing an old sent receipt', async t => {
  const env = setup(t), client = await visitor(env, { quoted: true });
  body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
  await env.tick(); assert.equal(env.calls.delivery.length, 1);
  const original = env.store.notifications(client.id)[0];
  assert.equal(original.status, 'sent'); assert.equal(original.payload.quote.min, 12000);
  const next = { ...profile, features: [...profile.features, '导出文案表格'] };
  const revised = body(await send(env, client, '新增导出文案表格，联系邮箱改为 invalid.example.test。',
    input => semanticReply(input, { type: 'continue', nextProfile: next,
      contactAction: saveAction(input, { email: 'invalid.example.test' }), reply: fakeClaim }))).conversation;
  assert.ok(revised.profile.features.includes('导出文案表格')); assert.equal(revised.quote, null);
  assert.equal(revised.summaryConfirmed, false); assert.equal(env.store.notifications(client.id).length, 1);
  await env.tick(); assert.equal(env.calls.delivery.length, 1);
  const resumed = body(await send(env, client, '那先用之前登记的邮箱联系我，就按新增后的需求继续沟通。',
    input => semanticReply(input, { contactAction: saveAction(input) }))).conversation;
  const notifications = env.store.notifications(client.id);
  assert.equal(notifications.length, 2); assert.equal(notifications[0].status, 'pending'); assert.equal(notifications[1].id, original.id);
  assert.ok(notifications[0].payload.features.includes('导出文案表格')); assert.equal(notifications[0].payload.quote, null);
  assert.equal(notifications[0].payload.confirmed, false); assert.equal(notifications[0].payload.contact.email, syntheticEmail);
  assert.doesNotMatch(resumed.messages.at(-1).content, /群通知已发送成功/);
  await env.tick(); assert.equal(env.calls.delivery.length, 2);
  const sent = env.calls.delivery.at(-1).text.content;
  assert.ok(sent.includes('导出文案表格')); assert.ok(sent.includes(syntheticEmail)); assert.doesNotMatch(sent, /12000|18000/);
  body(await send(env, client, '是的，邮箱不变，谢谢。',
    input => semanticReply(input, { contactAction: saveAction(input) })));
  await env.tick(); assert.equal(env.calls.delivery.length, 2); assert.equal(env.store.notifications(client.id).length, 2);
});

function generatedContactCorrection(input, { clarifyOnRetry = false, calls = [] } = {}) {
  const latest = latestOf(input), state = input.conversationState;
  return generateReply({ ...input,
    settings: { model: { baseUrl: 'https://contact-model.example.test/v1', name: 'synthetic-contact-model', apiKey: 'synthetic-contact-key' } },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://contact-model.example.test/v1/chat/completions');
      calls.push(JSON.parse(options.body));
      const clarify = clarifyOnRetry && calls.length > 1;
      const output = {
        profile: { features: [...input.profile.features, '生成短视频'] },
        evidence: { features: [...input.profile.features.map(value => ({ source: 'message:previous-scope', quote: value })),
          { source: `message:${latest.id}`, quote: '生成短视频' }] },
        action: { type: 'continue', summaryVersion: state.summaryVersion, quoteVersion: state.quote?.version ?? null,
          sourceMessageId: latest.id, evidence: latest.content, scopeChanged: true },
        contactAction: clarify ? null : saveAction(input, { email: 'invalid.example.test' }),
        followUp: { acknowledgement: '收到新增功能。', questions: clarify ? ['你希望同事通过哪个有效邮箱继续联系？'] : [] },
      };
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }),
        { headers: { 'content-type': 'application/json' } });
    },
  });
}

test('real generator contact failure blocks old contact across later intake and confirmation until chat or form repairs it', async t => {
  for (const recovery of ['chat', 'form']) await t.test(recovery, async t => {
    const env = setup(t), client = await visitor(env, { quoted: true }), calls = [];
    body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
    await env.tick(); assert.equal(env.calls.delivery.length, 1);
    const failed = body(await send(env, client, '新增生成短视频，原邮箱已经不用了，只能用 invalid.example.test 联系我。',
      input => generatedContactCorrection(input, { calls })));
    assert.equal(calls.length, 2); assert.equal(failed.degraded, true);
    assert.ok(failed.conversation.profile.features.includes('生成短视频'));
    assert.equal(failed.conversation.quote, null); assert.equal(failed.conversation.contactSubmitted, false);
    assert.equal(failed.conversation.contactNeedsReview, undefined);
    assert.equal(failed.conversation.contactReviewRequired, undefined);
    assert.equal(env.store.getConversation(client.id).contactNeedsReview, true);
    await env.tick(); assert.equal(env.calls.delivery.length, 1); assert.equal(env.store.notifications(client.id).length, 1);

    const nextProfile = { ...env.store.getConversation(client.id).profile, outputs: '主图、详情长图和短视频' };
    const continued = body(await send(env, client, '输出就是主图、详情长图和短视频。', input => ({
      ...semanticReply(input, { type: 'continue', nextProfile }), ready: true,
    }))).conversation;
    assert.equal(continued.contactSubmitted, false); assert.equal(continued.summaryReady, true);
    assert.equal(env.store.getConversation(client.id).contactNeedsReview, true);
    await env.tick(); assert.equal(env.calls.delivery.length, 1);
    const confirmed = body(await client.agent.post(`${client.url}/confirm`).send({ version: continued.summaryVersion })).conversation;
    assert.equal(confirmed.summaryConfirmed, true); assert.equal(confirmed.contactSubmitted, false);
    assert.equal(env.store.getConversation(client.id).contactNeedsReview, true);
    await env.tick(); assert.equal(env.calls.delivery.length, 1); assert.equal(env.store.notifications(client.id).length, 1);

    const replacement = 'corrected-followup@example.test';
    const repaired = recovery === 'chat'
      ? body(await send(env, client, `邮箱写错了，正确的是 ${replacement}，请同事联系我。`,
        input => semanticReply(input, { contactAction: saveAction(input, { email: replacement }) }))).conversation
      : body(await client.agent.post(`${client.url}/contact`).send({ email: replacement, consent: true })).conversation;
    assert.equal(repaired.contactSubmitted, true); assert.equal(repaired.contactNeedsReview, undefined);
    assert.notEqual(env.store.getConversation(client.id).contactNeedsReview, true);
    const latest = env.store.notifications(client.id)[0];
    assert.equal(latest.status, 'pending'); assert.equal(latest.payload.contact.email, replacement);
    assert.ok(latest.payload.features.includes('生成短视频')); assert.equal(latest.payload.confirmed, true);
    assert.equal(latest.payload.contactNeedsReview, undefined);
    await env.tick(); assert.equal(env.calls.delivery.length, 2);
    assert.ok(env.calls.delivery.at(-1).text.content.includes(replacement));
    assert.ok(!env.calls.delivery.at(-1).text.content.includes(syntheticEmail));
  });
});

test('explicit model clarification after an invalid contact keeps the prior contact under review without discarding valid scope', async t => {
  const env = setup(t), client = await visitor(env, { quoted: true }), calls = [];
  body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
  const response = body(await send(env, client, '新增生成短视频，之前的邮箱不要用了，只能通过 invalid.example.test 联系。',
    input => generatedContactCorrection(input, { calls, clarifyOnRetry: true })));
  assert.equal(calls.length, 2); assert.equal(response.degraded, false);
  assert.ok(response.conversation.profile.features.includes('生成短视频')); assert.equal(response.conversation.quote, null);
  assert.equal(response.conversation.contactSubmitted, false); assert.equal(response.conversation.contactNeedsReview, undefined);
  assert.equal(env.store.getConversation(client.id).contactNeedsReview, true);
  assert.match(response.conversation.messages.at(-1).content, /有效邮箱/);
  assert.equal(activeNotifications(env, client).length, 0);
  await env.tick(); assert.equal(env.calls.delivery.length, 0);
  const later = body(await send(env, client, '好的，那先继续解释项目流程。', input => semanticReply(input))).conversation;
  assert.equal(later.contactSubmitted, false); assert.equal(env.store.getConversation(client.id).contactNeedsReview, true);
  await env.tick(); assert.equal(env.calls.delivery.length, 0);
});

test('persisted contact review blocks both new queue entries and an existing pending worker job despite previous consent', async t => {
  const env = setup(t), client = await visitor(env);
  body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
  const pending = env.store.notifications(client.id)[0]; assert.equal(pending.status, 'pending');
  const c = env.store.getConversation(client.id); c.contactNeedsReview = true; env.store.saveConversation(c);
  assert.equal(c.contact.consent, true, 'review is separate from the recorded historical consent');
  assert.equal(queueLead(env.store, c, { force: true }), false);
  assert.equal(env.store.notifications(client.id).length, 1);
  await env.tick(); assert.equal(env.calls.delivery.length, 0);
  const exposed = body(await client.agent.get(client.url)).conversation;
  assert.equal(exposed.contactSubmitted, false); assert.equal(exposed.contactNeedsReview, undefined);
  const resumed = body(await send(env, client, '我确认之前登记的邮箱仍然有效，可以继续联系我。',
    input => semanticReply(input, { contactAction: saveAction(input) }))).conversation;
  assert.equal(resumed.contactSubmitted, true); assert.notEqual(env.store.getConversation(client.id).contactNeedsReview, true);
  await env.tick(); assert.equal(env.calls.delivery.length, 1);
});

test('an adapter cannot both require contact review and execute an otherwise valid save action', async t => {
  const env = setup(t), client = await visitor(env);
  body(await client.agent.post(`${client.url}/contact`).send({ email: syntheticEmail, consent: true }));
  const replacement = 'contradictory-adapter@example.test';
  const response = body(await send(env, client, `以后用 ${replacement} 联系我。`, input => ({
    ...semanticReply(input, { contactAction: saveAction(input, { email: replacement }), reply: fakeClaim }),
    contactReviewRequired: true,
  }))).conversation;
  const stored = env.store.getConversation(client.id);
  assert.equal(stored.contact.email, syntheticEmail); assert.equal(stored.contactNeedsReview, true);
  assert.equal(response.contactSubmitted, false); assert.equal(response.contactNeedsReview, undefined);
  assertNoFalseReceipt(response); assert.equal(activeNotifications(env, client).length, 0);
  await env.tick(); assert.equal(env.calls.delivery.length, 0);
});
