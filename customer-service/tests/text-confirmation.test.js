import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { retrieveQuote } from '../server/intelligence.js';

// Public API tests with deliberately scripted semantic actions. These tests
// verify business-state enforcement, not a model's understanding of any phrase.
// All data is synthetic and isolated. One hold test invokes the unconfigured
// local worker to verify delivery suspension; no live service is contacted.
const profile = {
  project: '合成店铺素材助手', scenario: '店铺商品运营', problem: '',
  features: ['生成商品图', '生成商品文案'], inputs: '商品照片和参数表',
  outputs: '主图和详情长图', integrations: '不自动发布', budget: '', timeline: '',
};
const quoteResult = version => ({
  status: 'quoted', quote: { min: 12000, max: 18000, currency: 'CNY', version, note: '合成参考区间，最终由人工确认。' },
  sources: ['synthetic-confirmation-case'],
});
function semanticReply(input, type, { action = {}, result = {} } = {}) {
  const latest = input.messages.findLast(message => message.role === 'user');
  const state = input.conversationState;
  assert.ok(state, 'the app must pass state from before suspending the old quote');
  return {
    profile: structuredClone(input.profile), ready: state.summaryReady, degraded: false,
    reply: '收到你的补充啦，我们继续确认这份项目范围。',
    action: {
      type, summaryVersion: state.summaryVersion, quoteVersion: state.quote?.version ?? null,
      sourceMessageId: latest.id, evidence: latest.content, scopeChanged: type === 'continue', ...action,
    },
    ...result,
  };
}
function continuation(input, nextProfile = profile, result = {}) {
  return semanticReply(input, 'continue', {
    result: { profile: structuredClone(nextProfile), ready: true, reply: '以下是待你确认的合成项目需求摘要。你可以确认需求，也可以告诉我哪里要调整。', ...result },
  });
}
function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'concierge-text-confirm-'));
  const store = openStore(dir), calls = { reply: [], quote: [], unscripted: 0 };
  const scripted = [options.initialReply || (input => continuation(input))];
  const application = createApp(store, {
    rateLimits: false,
    replyFn: async input => {
      calls.reply.push(structuredClone(input));
      const next = scripted.shift();
      if (!next) { calls.unscripted++; throw new Error('Missing scripted semantic response.'); }
      return next(input);
    },
    quoteFn: async input => {
      calls.quote.push(structuredClone(input));
      return options.quoteFn ? options.quoteFn(input) : quoteResult(input.version);
    },
    parseFn: async ({ name, mime }) => ({ name, mime, status: 'parsed', kind: 'document', text: '合成附件：新增一项输出。' }),
    fetchImpl: async () => { throw new Error('This test must not send enterprise notifications.'); },
  });
  t.after(() => {
    store.close(); rmSync(dir, { recursive: true, force: true });
    assert.equal(calls.unscripted, 0, 'all model decisions in this suite must be explicitly scripted');
  });
  return { ...application, store, calls, enqueueReply: reply => scripted.push(reply) };
}
function body(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function readyVisitor(app) {
  const agent = request.agent(app);
  const conversation = body(await agent.get('/api/session')).conversation;
  const url = `/api/conversations/${conversation.id}`;
  const ready = body(await agent.post(`${url}/messages`).send({ content: '我需要搭建一个商品素材生成助手。',
    requestId: 'synthetic-introduction', summaryVersion: conversation.summaryVersion })).conversation;
  return { agent, conversation: ready, url };
}
async function quoteByButton(visitor) {
  return body(await visitor.agent.post(`${visitor.url}/confirm`).send({ version: visitor.conversation.summaryVersion })).conversation;
}
async function contact(visitor) {
  return body(await visitor.agent.post(`${visitor.url}/contact`).send({ email: 'synthetic-followup@example.test', consent: true })).conversation;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function stateOf(conversation, hasNewAttachments = false) {
  const { summaryVersion, summaryReady, summaryConfirmed, feedback, knowledgeStatus } = conversation;
  const quote = conversation.quote ? Object.fromEntries(['version', 'min', 'max', 'currency'].map(key => [key, conversation.quote[key]])) : null;
  return { summaryVersion, summaryReady, summaryConfirmed, quote, feedback, knowledgeStatus, hasNewAttachments,
    contactAvailable:!!conversation.contactSubmitted,contactConsented:!!conversation.contactSubmitted,contactFields:conversation.contactSubmitted?['email']:[] };
}

test('a grounded semantic confirmation uses the button flow and preserves the summary version', async t => {
  for (const content of ['确认', '需求没问题', '好的', '你整理得准确，可以照这个范围评估了']) await t.test(content, async t => {
    const { app, calls, enqueueReply } = setup(t);
    const visitor = await readyVisitor(app);
    enqueueReply(input => semanticReply(input, 'confirm_requirements'));
    const result = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content, requestId: 'semantic-confirm',
      summaryVersion: visitor.conversation.summaryVersion })).conversation;
    assert.equal(calls.reply.length, 2, 'confirmation intent comes from the model, not a word whitelist');
    assert.deepEqual(calls.reply[1].conversationState, stateOf(visitor.conversation));
    assert.equal(result.summaryConfirmed, true);
    assert.equal(result.summaryVersion, visitor.conversation.summaryVersion);
    assert.equal(result.quote.version, visitor.conversation.summaryVersion);
    assert.equal(result.quote.min, 12000);
    assert.equal(calls.quote.length, 1);
    assert.deepEqual(calls.quote[0].profile, profile);
    assert.equal(result.feedback, 'not_quoted', 'requirement confirmation does not accept an unseen price');
    assert.equal(result.contactSubmitted, false, 'confirmation cannot grant contact consent');
    assert.equal(result.followupStatus, 'pending');
    assert.equal(result.messages.at(-2).content, content);
    assert.match(result.messages.at(-1).content, /需求确认好|参考区间/);

    const otherApp = setup(t), other = await readyVisitor(otherApp.app);
    const button = await quoteByButton(other);
    assert.deepEqual(button.quote, result.quote);
    assert.equal(button.knowledgeStatus, result.knowledgeStatus);
    assert.equal(button.messages.at(-1).content, result.messages.at(-1).content);
    assert.equal(otherApp.calls.reply.length, 1);
  });
});

test('the same short answer follows its scripted context action instead of a global word rule', async t => {
  for (const type of ['confirm_requirements', 'respond', 'continue']) await t.test(type, async t => {
    const { app, calls, enqueueReply } = setup(t);
    const visitor = await readyVisitor(app);
    enqueueReply(input => type === 'continue' ? continuation(input, { ...profile, timeline: '暂时不确定' }) : semanticReply(input, type));
    const result = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '好的', requestId: 'contextual-short-answer',
      summaryVersion: visitor.conversation.summaryVersion })).conversation;
    assert.equal(calls.reply.length, 2);
    assert.equal(result.summaryConfirmed, type === 'confirm_requirements');
    assert.equal(calls.quote.length, type === 'confirm_requirements' ? 1 : 0);
    assert.equal(result.summaryVersion, visitor.conversation.summaryVersion + (type === 'continue' ? 1 : 0));
  });
});

test('request retries are idempotent and repeat confirmation restores notifications without requeuing', async t => {
  const { app, calls, store, enqueueReply } = setup(t);
  const visitor = await readyVisitor(app);
  await contact(visitor);
  enqueueReply(input => semanticReply(input, 'confirm_requirements'));
  const requestBody = { content: '确认需求', requestId: 'one-confirmation', summaryVersion: visitor.conversation.summaryVersion };
  const first = body(await visitor.agent.post(`${visitor.url}/messages`).send(requestBody)).conversation;
  const afterFirst = structuredClone(store.notifications(first.id));
  assert.equal(afterFirst.filter(item => item.status !== 'superseded').length, 1);
  const retried = body(await visitor.agent.post(`${visitor.url}/messages`).send(requestBody)).conversation;
  assert.deepEqual(retried, first);
  assert.deepEqual(store.notifications(first.id), afterFirst);
  assert.equal(calls.reply.length, 2);

  enqueueReply(input => semanticReply(input, 'confirm_requirements'));
  const repeated = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '还是按刚才确认的需求',
    requestId: 'repeat-confirmation', summaryVersion: first.summaryVersion })).conversation;
  assert.equal(repeated.summaryVersion, first.summaryVersion);
  assert.equal(repeated.summaryConfirmed, true);
  assert.deepEqual(repeated.quote, first.quote);
  assert.equal(repeated.feedback, 'not_quoted');
  assert.equal(calls.reply.length, 3);
  assert.equal(calls.quote.length, 1);
  assert.deepEqual(store.notifications(first.id), afterFirst);
  assert.match(repeated.messages.at(-1).content, /已经确认/);
});

test('no knowledge configuration confirms requirements and routes to human assessment without a summary loop', async t => {
  const { app, calls, enqueueReply } = setup(t, { quoteFn: retrieveQuote });
  const visitor = await readyVisitor(app);
  enqueueReply(input => semanticReply(input, 'confirm_requirements'));
  const confirmed = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '整理准确，确认需求',
    requestId: 'no-knowledge-confirm', summaryVersion: visitor.conversation.summaryVersion })).conversation;
  assert.equal(confirmed.summaryConfirmed, true);
  assert.equal(confirmed.summaryVersion, visitor.conversation.summaryVersion);
  assert.equal(confirmed.knowledgeStatus, 'not_configured');
  assert.equal(confirmed.quote, null);
  assert.equal(confirmed.handoff, true);
  assert.match(confirmed.messages.at(-1).content, /同事.*评估|人工/);
  assert.doesNotMatch(confirmed.messages.at(-1).content, /待你确认|大概的预算/);
  enqueueReply(input => semanticReply(input, 'confirm_requirements'));
  const repeated = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '确认',
    requestId: 'no-knowledge-repeat', summaryVersion: confirmed.summaryVersion })).conversation;
  assert.equal(repeated.summaryConfirmed, true);
  assert.equal(repeated.quote, null);
  assert.equal(calls.reply.length, 3);
  assert.equal(calls.quote.length, 1);
  assert.match(repeated.messages.at(-1).content, /已经确认/);
});

test('scripted negation, questions and amendments are handled without accidental confirmation', async t => {
  const cases = [
    { content: '还不能确认', type: 'continue', next: { ...profile }, ready: false },
    { content: '确认后就会直接下单吗？', type: 'respond' },
    { content: '确认，但还需要增加视频输出', type: 'continue', next: { ...profile, features: [...profile.features, '生成视频'] }, ready: true },
  ];
  for (const scenario of cases) await t.test(scenario.content, async t => {
    const { app, calls, enqueueReply } = setup(t);
    const visitor = await readyVisitor(app);
    enqueueReply(input => scenario.type === 'respond'
      ? semanticReply(input, 'respond', { result: { reply: '这里只确认需求范围，后续方案和价格仍需人工确认。' } })
      : continuation(input, scenario.next, { ready: scenario.ready }));
    const result = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: scenario.content,
      requestId: 'not-a-confirmation', summaryVersion: visitor.conversation.summaryVersion })).conversation;
    assert.equal(result.summaryConfirmed, false);
    assert.equal(result.quote, null);
    assert.equal(calls.quote.length, 0);
    assert.equal(calls.reply.length, 2);
    assert.equal(result.summaryVersion, visitor.conversation.summaryVersion + (scenario.type === 'continue' ? 1 : 0));
  });
});

test('new attachments prevent non-change actions and ordinary material analysis remains available', async t => {
  for (const type of ['confirm_requirements', 'respond', 'continue']) await t.test(type, async t => {
    const { app, calls, enqueueReply } = setup(t);
    const visitor = await readyVisitor(app);
    const upload = body(await visitor.agent.post(`${visitor.url}/attachments`)
      .attach('file', Buffer.from('synthetic new requirements'), { filename: 'scope.pdf', contentType: 'application/pdf' })).attachment;
    enqueueReply(input => type === 'continue' ? continuation(input) : semanticReply(input, type));
    const response = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '确认', requestId: 'confirm-with-file',
      summaryVersion: visitor.conversation.summaryVersion, attachmentIds: [upload.id] }));
    assert.equal(response.conversation.summaryConfirmed, false);
    assert.equal(response.conversation.quote, null);
    assert.equal(response.conversation.summaryVersion, visitor.conversation.summaryVersion + 1);
    assert.equal(calls.quote.length, 0);
    assert.equal(calls.reply[1].conversationState.hasNewAttachments, true);
    assert.equal(calls.reply[1].attachments[0].id, upload.id);
    if (type !== 'continue') assert.equal(response.degraded, true);
  });
});

test('a semantic action cannot confirm a not-ready or incomplete profile', async t => {
  for (const [label, nextProfile, ready] of [
    ['not ready', profile, false], ['incomplete despite a claimed ready flag', { ...profile, inputs: '' }, true],
  ]) await t.test(label, async t => {
    const { app, calls, enqueueReply } = setup(t, { initialReply: input => continuation(input, nextProfile, { ready }) });
    const visitor = await readyVisitor(app);
    enqueueReply(input => semanticReply(input, 'confirm_requirements'));
    const response = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '确认',
      requestId: 'premature-confirm', summaryVersion: visitor.conversation.summaryVersion }));
    assert.equal(response.degraded, true);
    assert.equal(response.conversation.summaryConfirmed, false);
    assert.equal(response.conversation.quote, null);
    assert.equal(calls.quote.length, 0);
    assert.equal(calls.reply.length, 2);
  });
});

test('invalid semantic bindings degrade honestly and cannot preserve an old quote or mark acceptance', async t => {
  const invalid = [
    ['stale summary version', input => semanticReply(input, 'confirm_requirements', { action: { summaryVersion: input.conversationState.summaryVersion - 1 } })],
    ['stale quote version', input => semanticReply(input, 'quote_feedback', { action: { quoteVersion: input.conversationState.quote.version - 1, feedback: 'accepted' } })],
    ['wrong latest source id', input => semanticReply(input, 'confirm_requirements', { action: { sourceMessageId: 'not-the-latest-message' } })],
    ['partial evidence hides the correction', input => semanticReply(input, 'confirm_requirements', { action: { evidence: '确认' } })],
    ['old customer evidence', input => semanticReply(input, 'confirm_requirements', { action: { sourceMessageId: input.messages.find(message => message.role === 'user').id, evidence: input.messages.find(message => message.role === 'user').content } })],
    ['scope change declared', input => semanticReply(input, 'confirm_requirements', { action: { scopeChanged: true } })],
    ['profile changed despite no-change claim', input => semanticReply(input, 'confirm_requirements', { result: { profile: { ...input.profile, outputs: '新增视频' } } })],
    ['unsupported feedback', input => semanticReply(input, 'quote_feedback', { action: { feedback: 'signed_contract' } })],
    ['unknown action', input => semanticReply(input, 'autocontract')],
    ['null action', input => semanticReply(input, 'respond', { result: { action: null } })],
    ['false action', input => semanticReply(input, 'respond', { result: { action: false } })],
    ['empty string action', input => semanticReply(input, 'respond', { result: { action: '' } })],
    ['zero action', input => semanticReply(input, 'respond', { result: { action: 0 } })],
  ];
  for (const [label, reply] of invalid) await t.test(label, async t => {
    const { app, calls, enqueueReply } = setup(t);
    const visitor = await readyVisitor(app);
    const quoted = await quoteByButton(visitor);
    enqueueReply(reply);
    const response = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '确认，不过需要补充输出范围',
      requestId: 'invalid-action', summaryVersion: quoted.summaryVersion }));
    assert.equal(response.degraded, true);
    assert.equal(response.conversation.summaryConfirmed, false);
    assert.equal(response.conversation.summaryReady, false);
    assert.equal(response.conversation.quote, null);
    assert.equal(response.conversation.feedback, 'not_quoted');
    assert.equal(response.conversation.summaryVersion, quoted.summaryVersion + 1);
    assert.equal(calls.quote.length, 1);
    assert.equal(calls.reply.length, 2);
  });
});

test('legacy mocks without actions remain ordinary updates, never a word-based confirmation', async t => {
  const { app, calls, enqueueReply } = setup(t);
  const visitor = await readyVisitor(app), quoted = await quoteByButton(visitor);
  enqueueReply(input => ({ profile: input.profile, ready: true, degraded: false, reply: '已重新整理当前范围，请核对。' }));
  const result = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '确认', requestId: 'legacy-mock',
    summaryVersion: quoted.summaryVersion })).conversation;
  assert.equal(result.summaryVersion, quoted.summaryVersion + 1);
  assert.equal(result.summaryConfirmed, false);
  assert.equal(result.quote, null);
  assert.equal(calls.quote.length, 1);
  assert.equal(calls.reply.length, 2);
});

test('all stale client versions are rejected before adding a message, analyzing or consuming the request id', async t => {
  for (const content of ['确认', '我再补充一种图片尺寸', '这个区间可以接受']) await t.test(content, async t => {
    const { app, calls, store, enqueueReply } = setup(t);
    const visitor = await readyVisitor(app);
    const before = structuredClone(store.getConversation(visitor.conversation.id));
    const response = await visitor.agent.post(`${visitor.url}/messages`).send({ content, requestId: 'stale-client', summaryVersion: before.summaryVersion - 1 });
    assert.equal(response.status, 409);
    assert.deepEqual(store.getConversation(before.id), before);
    assert.equal(calls.reply.length, 1);
    assert.equal(calls.quote.length, 0);
    enqueueReply(input => continuation(input));
    body(await visitor.agent.post(`${visitor.url}/messages`).send({ content, requestId: 'stale-client', summaryVersion: before.summaryVersion }));
    assert.equal(calls.reply.length, 2);
  });
});

test('versionless old tabs can submit ordinary content but cannot confirm or accept a quote', async t => {
  for (const type of ['continue', 'confirm_requirements', 'quote_feedback']) await t.test(type, async t => {
    const { app, calls, store, enqueueReply } = setup(t);
    const visitor = await readyVisitor(app);
    const previous = type === 'quote_feedback' ? await quoteByButton(visitor) : visitor.conversation;
    await contact(visitor);
    const before = structuredClone(store.notifications(previous.id));
    enqueueReply(input => type === 'continue' ? continuation(input, { ...profile, outputs: '新增一套横幅' })
      : semanticReply(input, type, { action: type === 'quote_feedback' ? { feedback: 'accepted' } : {} }));
    const result = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: type === 'continue' ? '还需要一套横幅' : '可以',
      requestId: 'versionless-tab' })).conversation;
    assert.equal(calls.reply.length, 2);
    if (type === 'continue') {
      assert.equal(result.summaryVersion, previous.summaryVersion + 1);
      assert.equal(result.profile.outputs, '新增一套横幅');
    } else {
      assert.equal(result.summaryVersion, previous.summaryVersion);
      assert.equal(result.summaryConfirmed, previous.summaryConfirmed);
      assert.deepEqual(result.quote, previous.quote);
      assert.equal(result.feedback, previous.feedback);
      assert.deepEqual(store.notifications(previous.id), before);
      assert.match(result.messages.at(-1).content, /刷新|按钮/);
    }
    assert.equal(calls.quote.length, type === 'quote_feedback' ? 1 : 0);
  });
});

test('current quote feedback cannot grant contact consent or final-sale status', async t => {
  for (const feedback of ['accepted', 'too_high', 'considering']) await t.test(feedback, async t => {
    const { app, calls, enqueueReply } = setup(t);
    const visitor = await readyVisitor(app), quoted = await quoteByButton(visitor);
    enqueueReply(input => semanticReply(input, 'quote_feedback', { action: { feedback } }));
    const result = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: `合成客户对当前报价的反馈：${feedback}`,
      requestId: 'semantic-price-feedback', summaryVersion: quoted.summaryVersion })).conversation;
    assert.equal(result.feedback, feedback);
    assert.equal(result.summaryConfirmed, true);
    assert.equal(result.summaryVersion, quoted.summaryVersion);
    assert.deepEqual(result.quote, quoted.quote);
    assert.equal(result.contactSubmitted, false);
    assert.equal(result.followupStatus, 'pending');
    assert.equal(calls.quote.length, 1);
    assert.equal(calls.reply.length, 2);
    assert.deepEqual(calls.reply[1].conversationState, stateOf(quoted));
  });
});

test('feedback without a quote cannot create a price or mark customer acceptance', async t => {
  const { app, calls, enqueueReply } = setup(t);
  const visitor = await readyVisitor(app);
  enqueueReply(input => semanticReply(input, 'quote_feedback', { action: { feedback: 'accepted' } }));
  const response = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '可以', requestId: 'unseen-quote-feedback',
    summaryVersion: visitor.conversation.summaryVersion }));
  assert.equal(response.degraded, true);
  assert.equal(response.conversation.feedback, 'not_quoted');
  assert.equal(response.conversation.quote, null);
  assert.equal(response.conversation.summaryConfirmed, false);
  assert.equal(calls.quote.length, 0);
});

test('new quote feedback creates one necessary update and repeating that feedback preserves delivery progress', async t => {
  const { app, calls, store, enqueueReply } = setup(t);
  const visitor = await readyVisitor(app), quoted = await quoteByButton(visitor);
  await contact(visitor);
  const initial = structuredClone(store.notifications(quoted.id));
  enqueueReply(input => semanticReply(input, 'quote_feedback', { action: { feedback: 'accepted' } }));
  const first = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '这个参考区间符合预期',
    requestId: 'new-price-feedback', summaryVersion: quoted.summaryVersion })).conversation;
  const afterFirst = structuredClone(store.notifications(quoted.id));
  assert.equal(afterFirst.length, initial.length + 1);
  assert.equal(afterFirst.filter(item => item.status !== 'superseded').length, 1);
  assert.equal(afterFirst.find(item => item.status !== 'superseded').payload.feedback, 'accepted');
  enqueueReply(input => semanticReply(input, 'quote_feedback', { action: { feedback: 'accepted' } }));
  const repeated = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '对，这个区间我可以接受',
    requestId: 'repeat-price-feedback', summaryVersion: quoted.summaryVersion })).conversation;
  assert.equal(repeated.feedback, 'accepted');
  assert.deepEqual(repeated.quote, first.quote);
  assert.deepEqual(store.notifications(quoted.id), afterFirst);
  assert.equal(calls.quote.length, 1);
  assert.equal(calls.reply.length, 3);
});

test('respond before confirmation does not queue a new unconfirmed customer-note snapshot', async t => {
  const { app, store, enqueueReply } = setup(t);
  const visitor = await readyVisitor(app);
  await contact(visitor);
  const before = structuredClone(store.notifications(visitor.conversation.id));
  enqueueReply(input => semanticReply(input, 'respond', { result: { reply: '需求确认只用于核对项目范围，不代表签约。' } }));
  const result = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '确认需求以后就算签约了吗？',
    requestId: 'unconfirmed-scope-question', summaryVersion: visitor.conversation.summaryVersion })).conversation;
  assert.equal(result.summaryVersion, visitor.conversation.summaryVersion);
  assert.equal(result.summaryConfirmed, false);
  assert.equal(result.quote, null);
  assert.deepEqual(store.notifications(visitor.conversation.id), before);
});

test('respond preserves confirmed scope, quote and pending notification delivery without new snapshots', async t => {
  const { app, calls, store, enqueueReply } = setup(t);
  const visitor = await readyVisitor(app), quoted = await quoteByButton(visitor);
  await contact(visitor);
  const before = structuredClone(store.notifications(quoted.id));
  enqueueReply(input => semanticReply(input, 'respond', { result: { reply: '当前展示的是参考区间，最终方案仍由同事确认。' } }));
  const result = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '这个区间是最终价格吗？',
    requestId: 'price-question', summaryVersion: quoted.summaryVersion })).conversation;
  assert.equal(result.summaryVersion, quoted.summaryVersion);
  assert.equal(result.summaryConfirmed, true);
  assert.deepEqual(result.quote, quoted.quote);
  assert.deepEqual(result.profile, quoted.profile);
  assert.equal(result.feedback, quoted.feedback);
  assert.deepEqual(store.notifications(quoted.id), before);
  assert.equal(calls.quote.length, 1);
  assert.equal(calls.reply.length, 2);
  assert.equal(result.messages.at(-1).content, '当前展示的是参考区间，最终方案仍由同事确认。');
});

test('old quote and queued snapshots are unavailable during analysis and restore after a valid respond', { timeout: 6000 }, async t => {
  const entered = deferred(), release = deferred();
  const { app, store, tick, enqueueReply } = setup(t);
  const visitor = await readyVisitor(app), quoted = await quoteByButton(visitor);
  await contact(visitor);
  const before = structuredClone(store.notifications(quoted.id));
  enqueueReply(async input => { entered.resolve(input); await release.promise; return semanticReply(input, 'respond'); });
  const pending = visitor.agent.post(`${visitor.url}/messages`).send({ content: '请解释一下当前的参考区间', requestId: 'delayed-analysis',
    summaryVersion: quoted.summaryVersion }).then(response => response);
  try {
    const modelInput = await entered.promise;
    assert.deepEqual(modelInput.conversationState, stateOf({...quoted,contactSubmitted:true}));
    const during = body(await visitor.agent.get(visitor.url)).conversation;
    assert.equal(during.quote, null);
    assert.equal(during.summaryConfirmed, false);
    assert.equal(during.summaryReady, false);
    assert.equal(during.summaryVersion, quoted.summaryVersion + 1);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM notification_holds WHERE conversation_id=?').get(quoted.id).count, 1);
    await tick();
    assert.deepEqual(store.notifications(quoted.id), before, 'the hold prevents even an unconfigured worker from progressing old snapshots');
    assert.equal((await visitor.agent.post(`${visitor.url}/feedback`).send({ version: quoted.quote.version, feedback: 'accepted' })).status, 409);
    assert.equal((await visitor.agent.post(`${visitor.url}/confirm`).send({ version: quoted.summaryVersion })).status, 409);
  } finally { release.resolve(); }
  const restored = body(await pending).conversation;
  assert.equal(restored.summaryVersion, quoted.summaryVersion);
  assert.equal(restored.summaryConfirmed, true);
  assert.deepEqual(restored.quote, quoted.quote);
  assert.deepEqual(store.notifications(quoted.id), before);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM notification_holds WHERE conversation_id=?').get(quoted.id).count, 0);
  await tick();
  assert.equal(store.notifications(quoted.id).filter(item => item.status === 'awaiting_configuration').length, 1,
    'after release the original snapshot can progress without adding a second notification');
});

test('scope changes and analysis failures keep old quotes invalid and old snapshots superseded', async t => {
  for (const failure of [false, true]) await t.test(failure ? 'model failure' : 'scope update', async t => {
    const { app, calls, store, enqueueReply } = setup(t);
    const visitor = await readyVisitor(app), quoted = await quoteByButton(visitor);
    await contact(visitor);
    const oldIds = store.notifications(quoted.id).filter(item => item.status !== 'superseded').map(item => item.id);
    enqueueReply(input => {
      if (failure) throw new Error('Synthetic model failure.');
      return continuation(input, { ...profile, features: [...profile.features, '生成视频'] });
    });
    const response = body(await visitor.agent.post(`${visitor.url}/messages`).send({ content: '需要增加视频功能',
      requestId: 'revised-scope', summaryVersion: quoted.summaryVersion }));
    assert.equal(response.conversation.summaryVersion, quoted.summaryVersion + 1);
    assert.equal(response.conversation.summaryConfirmed, false);
    assert.equal(response.conversation.quote, null);
    assert.equal(response.conversation.feedback, 'not_quoted');
    assert.equal(calls.quote.length, 1);
    assert.equal((await visitor.agent.post(`${visitor.url}/feedback`).send({ version: quoted.quote.version, feedback: 'accepted' })).status, 409);
    for (const id of oldIds) assert.equal(store.notifications(quoted.id).find(item => item.id === id).status, 'superseded');
    if (failure) {
      assert.equal(response.degraded, true);
      assert.equal(response.conversation.summaryReady, false);
      assert.equal((await visitor.agent.post(`${visitor.url}/confirm`).send({ version: response.conversation.summaryVersion })).status, 400);
    }
  });
});

test('withdrawing confirmed scope invalidates its quote even when no replacement profile facts exist yet', async t => {
  const { app, calls, store, enqueueReply } = setup(t);
  const visitor = await readyVisitor(app), quoted = await quoteByButton(visitor);
  await contact(visitor);
  const oldIds = store.notifications(quoted.id).filter(item => item.status !== 'superseded').map(item => item.id);
  enqueueReply(input => semanticReply(input, 'continue', {
    action: { scopeChanged: true }, result: { ready: false, reply: '收到，先不沿用刚才的范围啦。你想优先调整哪一部分？' },
  }));
  const response = body(await visitor.agent.post(`${visitor.url}/messages`).send({
    content: '先别按刚才的需求了，这版我不认可，我再想一下怎么改', requestId: 'withdraw-confirmed-scope',
    summaryVersion: quoted.summaryVersion,
  }));
  assert.equal(response.degraded, false);
  assert.deepEqual(response.conversation.profile, quoted.profile, 'retain recorded facts while waiting for the actual amendments');
  assert.equal(response.conversation.summaryVersion, quoted.summaryVersion + 1);
  assert.equal(response.conversation.summaryReady, false);
  assert.equal(response.conversation.summaryConfirmed, false);
  assert.equal(response.conversation.quote, null);
  assert.equal(response.conversation.feedback, 'not_quoted');
  assert.match(response.conversation.messages.at(-1).content, /调整.*[?？]/u);
  assert.equal(calls.quote.length, 1, 'do not reprice rejected scope');
  assert.equal(calls.reply.length, 2);
  assert.equal((await visitor.agent.post(`${visitor.url}/feedback`).send({ version: quoted.quote.version, feedback: 'accepted' })).status, 409);
  assert.equal((await visitor.agent.post(`${visitor.url}/confirm`).send({ version: response.conversation.summaryVersion })).status, 400);
  for (const id of oldIds) assert.equal(store.notifications(quoted.id).find(item => item.id === id).status, 'superseded');
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM notification_holds WHERE conversation_id=?').get(quoted.id).count, 0);
});

test('button and semantic text confirmation share one lock without duplicate quote work', { timeout: 8000 }, async t => {
  for (const first of ['text', 'button']) await t.test(`${first} starts first`, async t => {
    const entered = deferred(), release = deferred();
    const { app, calls, enqueueReply } = setup(t, { quoteFn: async ({ version }) => {
      entered.resolve(); await release.promise; return quoteResult(version);
    } });
    const visitor = await readyVisitor(app);
    enqueueReply(input => semanticReply(input, 'confirm_requirements'));
    const textBody = { content: '确认', requestId: 'concurrent-confirm', summaryVersion: visitor.conversation.summaryVersion };
    const pending = (first === 'text' ? visitor.agent.post(`${visitor.url}/messages`).send(textBody)
      : visitor.agent.post(`${visitor.url}/confirm`).send({ version: visitor.conversation.summaryVersion })).then(response => response);
    try {
      await entered.promise;
      const rejected = first === 'text' ? await visitor.agent.post(`${visitor.url}/confirm`).send({ version: visitor.conversation.summaryVersion })
        : await visitor.agent.post(`${visitor.url}/messages`).send(textBody);
      assert.equal(rejected.status, 409);
      assert.equal(calls.quote.length, 1);
    } finally { release.resolve(); }
    const completed = body(await pending).conversation;
    assert.equal(completed.summaryConfirmed, true);
    const retry = first === 'text' ? body(await visitor.agent.post(`${visitor.url}/confirm`).send({ version: completed.summaryVersion })).conversation
      : body(await visitor.agent.post(`${visitor.url}/messages`).send(textBody)).conversation;
    assert.deepEqual(retry.quote, completed.quote);
    assert.equal(retry.summaryVersion, visitor.conversation.summaryVersion);
    assert.equal(calls.quote.length, 1);
    assert.equal(calls.reply.length, 2);
  });
});

test('a request retried during quotation conflicts, then becomes idempotent after completion', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  const { app, calls, enqueueReply } = setup(t, { quoteFn: async ({ version }) => {
    entered.resolve(); await release.promise; return quoteResult(version);
  } });
  const visitor = await readyVisitor(app);
  enqueueReply(input => semanticReply(input, 'confirm_requirements'));
  const input = { content: '需求确认', requestId: 'same-concurrent-request', summaryVersion: visitor.conversation.summaryVersion };
  const pending = visitor.agent.post(`${visitor.url}/messages`).send(input).then(response => response);
  try {
    await entered.promise;
    assert.equal((await visitor.agent.post(`${visitor.url}/messages`).send(input)).status, 409);
  } finally { release.resolve(); }
  const completed = body(await pending).conversation;
  const retry = body(await visitor.agent.post(`${visitor.url}/messages`).send(input)).conversation;
  assert.deepEqual(retry, completed);
  assert.equal(calls.quote.length, 1);
  assert.equal(calls.reply.length, 2);
});

test('duplicate request ids remain idempotent after a scope update replaces their prior version', async t => {
  const { app, calls, enqueueReply } = setup(t);
  const visitor = await readyVisitor(app);
  enqueueReply(input => continuation(input, { ...profile, timeline: '暂时不确定' }));
  const message = { content: '暂时不确定交期', requestId: 'ordinary-update', summaryVersion: visitor.conversation.summaryVersion };
  const changed = body(await visitor.agent.post(`${visitor.url}/messages`).send(message)).conversation;
  assert.equal(changed.summaryVersion, visitor.conversation.summaryVersion + 1);
  assert.deepEqual(body(await visitor.agent.post(`${visitor.url}/messages`).send(message)).conversation, changed);
  assert.equal(calls.reply.length, 2);
  assert.equal(calls.quote.length, 0);
});
