import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, initialProfile } from '../server/intelligence.js';

// This suite verifies the action protocol with synthetic model responses. It
// does not claim a mock can establish the model's intent-classification quality.
const settings = { model: { baseUrl: 'https://actions.example.test/v1', name: 'synthetic-action-model', apiKey: 'synthetic-action-key' } };
const profile = { ...initialProfile(), project: '商品素材助手', scenario: '线上店铺', features: ['生成主图', '生成文案'],
  inputs: '商品照片', outputs: '主图和详情页文案', integrations: '不自动发布' };
const state = { summaryVersion: 7, summaryReady: true, summaryConfirmed: false, quote: null,
  feedback: 'not_quoted', knowledgeStatus: 'not_configured', hasNewAttachments: false };
const confirmed = { ...state, summaryConfirmed: true, quote: { version: 7, min: 12000, max: 18000, currency: 'CNY' },
  feedback: 'pending', knowledgeStatus: 'quoted' };
const user = { id: 'synthetic-latest', role: 'user', content: '这份需求没问题，可以按这个继续。' };
function action(type, message = user, current = state, extra = {}) {
  return { type, summaryVersion: current.summaryVersion, quoteVersion: current.quote?.version ?? null,
    sourceMessageId: message.id, evidence: message.content, scopeChanged: false, ...extra };
}
const response = (value, { acknowledgement = '', questions = [], fields = {} } = {}) => ({ profile: fields,
  followUp: { acknowledgement, questions }, action: value });
function sequence(values, calls = []) {
  return async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const value = values[Math.min(calls.length - 1, values.length - 1)];
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }),
      { headers: { 'content-type': 'application/json' } });
  };
}
const generate = (values, overrides = {}) => generateReply({ settings, profile, conversationState: state,
  messages: [{ id: 'synthetic-summary', role: 'assistant', content: '这是当前待确认的需求摘要，是否按此范围继续？' }, user],
  fetchImpl: sequence(values), ...overrides });

test('state and loaded Skill enter the actual request while confirmed actions leave business execution to the app', async () => {
  const calls = [];
  const result = await generate([], { fetchImpl: sequence([response(action('confirm_requirements'))], calls) });
  assert.equal(result.degraded, false); assert.equal(result.ready, true); assert.equal(result.reply, '');
  assert.deepEqual(result.action, action('confirm_requirements'));
  const input = JSON.parse(calls[0].messages[1].content);
  assert.deepEqual(input.conversationState, state); assert.equal(input.conversation.at(-1).id, user.id);
  assert.match(calls[0].messages[0].content, /confirm_requirements|quote_feedback/);
  for (const field of ['quote', 'summaryConfirmed', 'contactConsent']) assert.equal(result[field], undefined);
});

test('the same short response can carry context-specific actions without a fixed acknowledgement word list', async () => {
  const short = { ...user, content: '好' };
  const confirm = await generate([response(action('confirm_requirements', short))], { messages: [short] });
  assert.equal(confirm.action.type, 'confirm_requirements'); assert.equal(confirm.reply, '');
  const quote = await generate([response(action('quote_feedback', short, confirmed, { feedback: 'accepted' }))],
    { conversationState: confirmed, messages: [short] });
  assert.equal(quote.action.type, 'quote_feedback'); assert.equal(quote.action.feedback, 'accepted');
  const collecting = { ...state, summaryReady: false };
  const followUp = await generate([response(action('continue', short, collecting), { acknowledgement: '收到啦～', questions: ['你现有的商品素材有哪些？'] })],
    { conversationState: collecting, profile: { ...profile, inputs: '' }, messages: [short] });
  assert.equal(followUp.action.type, 'continue'); assert.equal(followUp.ready, false);
});

test('respond naturally answers a question without re-rendering a complete summary or changing quoted state', async () => {
  const message = { ...user, content: '参考区间里面包含服务器费用吗？' };
  const acknowledgement = '服务器和模型调用等费用是否包含，需要同事结合具体方案确认哦。';
  const result = await generate([response(action('respond', message, confirmed), { acknowledgement })],
    { messages: [message], conversationState: confirmed });
  assert.equal(result.degraded, false); assert.equal(result.action.type, 'respond'); assert.deepEqual(result.profile, profile);
  assert.equal(result.reply, acknowledgement); assert.doesNotMatch(result.reply, /待你确认|功能清单|预算是多少/);
  assert.equal(result.quote, undefined);
});

test('respond also works for incomplete profiles and uncertain intent without inventing readiness', async () => {
  const message = { ...user, content: '这个流程我还没看懂。' };
  const current = { ...state, summaryReady: false };
  const result = await generate([response(action('respond', message, current), {
    acknowledgement: '没关系，我可以把流程解释清楚～', questions: ['你主要想了解需求梳理还是后面的人工跟进？'],
  })], { profile: initialProfile(), messages: [message], conversationState: current });
  assert.equal(result.degraded, false); assert.equal(result.ready, false); assert.equal(result.action.type, 'respond');
  assert.match(result.reply, /把流程解释清楚/); assert.doesNotMatch(result.reply, /功能清单/);
});

test('non-continue actions require current state, complete evidence and no profile revision', async t => {
  const cases = [
    ['missing action', undefined], ['unknown action', action('submit_order')],
    ['wrong summary version', action('confirm_requirements', user, state, { summaryVersion: 6 })],
    ['version string', action('confirm_requirements', user, state, { summaryVersion: '7' })],
    ['wrong quote version', action('confirm_requirements', user, state, { quoteVersion: 7 })],
    ['wrong source', action('confirm_requirements', user, state, { sourceMessageId: 'older-user' })],
    ['partial evidence', action('confirm_requirements', user, state, { evidence: '这份需求没问题' })],
    ['invented evidence', action('confirm_requirements', user, state, { evidence: '已经确认全部需求' })],
    ['changed scope flag', action('confirm_requirements', user, state, { scopeChanged: true })],
    ['scope flag not boolean', action('confirm_requirements', user, state, { scopeChanged: 'false' })],
    ['unexpected feedback', action('respond', user, state, { feedback: 'accepted' })],
    ['extra execution permission', action('confirm_requirements', user, state, { contactConsent: true })],
  ];
  for (const [label, value] of cases) await t.test(label, async () => {
    const calls = [];
    const result = await generate([], { fetchImpl: sequence([response(value, { acknowledgement: '收到啦。' })], calls) });
    assert.equal(result.degraded, true); assert.equal(result.ready, false); assert.equal(result.action, undefined);
    assert.equal(calls.length, 2); assert.deepEqual(result.diagnostics.repairReasons, ['invalid_action', 'invalid_action']);
  });
});

test('full evidence normalization allows whitespace and full-width variants but never drops a correction', async () => {
  const message = { ...user, content: 'ＡＩ需求\n没问题，可以继续。' };
  const normalized = await generate([response(action('confirm_requirements', message, state, { evidence: 'AI需求 没问题，可以继续。' }))], { messages: [message] });
  assert.equal(normalized.degraded, false); assert.equal(normalized.action.evidence, message.content);
  const revision = { ...user, content: '确认，但是要增加数据审核功能。' };
  const truncated = await generate([response(action('confirm_requirements', revision, state, { evidence: '确认' }))], { messages: [revision] });
  assert.equal(truncated.degraded, true); assert.equal(truncated.action, undefined);
});

test('summary confirmation cannot occur before a shown complete scope, but same-version repeats remain idempotency candidates', async () => {
  for (const overrides of [{ conversationState: { ...state, summaryReady: false } }, { profile: { ...profile, inputs: '' } }]) {
    const result = await generate([response(action('confirm_requirements'))], overrides);
    assert.equal(result.degraded, true); assert.equal(result.action, undefined);
  }
  const already = { ...state, summaryReady: false, summaryConfirmed: true };
  const repeat = await generate([response(action('confirm_requirements', user, already))], { conversationState: already });
  assert.equal(repeat.degraded, false); assert.equal(repeat.action.type, 'confirm_requirements');
});

test('quote feedback requires the displayed quote version and an allowed opinion', async t => {
  for (const feedback of ['accepted', 'too_high', 'considering']) await t.test(feedback, async () => {
    const result = await generate([response(action('quote_feedback', user, confirmed, { feedback }))], { conversationState: confirmed });
    assert.equal(result.degraded, false); assert.equal(result.reply, ''); assert.equal(result.action.feedback, feedback);
  });
  for (const [label, value, current] of [
    ['no quote', action('quote_feedback', user, state, { feedback: 'accepted' }), state],
    ['invented outcome', action('quote_feedback', user, confirmed, { feedback: 'signed' }), confirmed],
    ['missing outcome', action('quote_feedback', user, confirmed), confirmed],
    ['old quote', action('quote_feedback', user, confirmed, { quoteVersion: 6, feedback: 'accepted' }), confirmed],
  ]) await t.test(label, async () => {
    const result = await generate([response(value)], { conversationState: current });
    assert.equal(result.degraded, true); assert.equal(result.action, undefined);
  });
});

test('new attachment or grounded field changes must use continue with scopeChanged true', async () => {
  const message = { ...user, content: '把输出改成营销长图。' };
  for (const type of ['respond', 'confirm_requirements', 'quote_feedback']) {
    const current = type === 'quote_feedback' ? confirmed : state;
    const value = action(type, message, current, type === 'quote_feedback' ? { feedback: 'accepted' } : {});
    const result = await generate([response(value, { fields: { outputs: '营销长图' }, acknowledgement: '收到啦。' })], { messages: [message], conversationState: current });
    assert.equal(result.degraded, true, type); assert.equal(result.action, undefined);
  }
  const revised = await generate([response(action('continue', message, state, { scopeChanged: true }), { fields: { outputs: '营销长图' } })], { messages: [message] });
  assert.equal(revised.degraded, false); assert.equal(revised.ready, true); assert.equal(revised.profile.outputs, '营销长图');
  assert.equal(revised.action.type, 'continue'); assert.match(revised.reply, /期望结果：营销长图/);
  for (const current of [{ ...state, hasNewAttachments: true }, state]) {
    const attached = { ...user, attachments: [{ id: 'synthetic-new-file' }] };
    const result = await generate([response(action('confirm_requirements', attached, current))], { messages: [attached], conversationState: current });
    assert.equal(result.degraded, true); assert.equal(result.action, undefined);
  }
});

test('a grounded revision cannot be erased between repair attempts to recover a stale confirmation', async () => {
  const message = { ...user, content: '改成营销长图。' };
  const calls = [];
  const result = await generate([], { messages: [message], fetchImpl: sequence([
    response(action('confirm_requirements', message), { fields: { outputs: '营销长图' } }),
    response(action('confirm_requirements', message)),
  ], calls) });
  assert.equal(result.degraded, true); assert.equal(result.action, undefined); assert.equal(result.profile.outputs, '营销长图');
  assert.equal(calls.length, 2); assert.equal(JSON.parse(calls[1].messages.at(-1).content).validation.actionError, 'action_scope_changed');
});

test('action validation can recover once and retains the original source context', async () => {
  const calls = [];
  const result = await generate([], { fetchImpl: sequence([
    response(action('confirm_requirements', user, state, { evidence: '没问题' })),
    response(action('confirm_requirements')),
  ], calls) });
  assert.equal(result.degraded, false); assert.equal(result.action.type, 'confirm_requirements'); assert.equal(calls.length, 2);
  assert.deepEqual(result.diagnostics.repairReasons, ['invalid_action']);
  assert.deepEqual(calls[1].messages[1], calls[0].messages[1]);
  assert.equal(calls[1].messages.at(-2).role, 'system');
});

test('actions cannot use free-text follow-up to fabricate prices or confirmations', async () => {
  const message = { ...user, content: '价格怎么计算？' };
  const unsafe = await generate([response(action('respond', message), { acknowledgement: '最终报价为8000元，已经通知同事了。' })], { messages: [message] });
  assert.equal(unsafe.degraded, true); assert.equal(unsafe.action, undefined); assert.doesNotMatch(unsafe.reply, /8000|已经通知/);
  const withQuestion = await generate([response(action('confirm_requirements'), { questions: ['是否还要增加一个模块？'] })]);
  assert.equal(withQuestion.degraded, true); assert.equal(withQuestion.action, undefined);
});

test('malformed caller state fails before a model request and without exposing configuration', async () => {
  let calls = 0;
  const result = await generateReply({ settings, profile, messages: [user], conversationState: { ...state, quote: { ...confirmed.quote, version: 6 } },
    fetchImpl: async () => { calls++; throw new Error('unexpected request'); } });
  assert.equal(calls, 0); assert.equal(result.degraded, true); assert.equal(result.reason, 'invalid_conversation_state');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-action-key/);
});
