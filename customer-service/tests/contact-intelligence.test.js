import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, initialProfile } from '../server/intelligence.js';

// Synthetic customer data and transport mocks only. These checks establish the
// contact-action contract; they do not prove a live model's semantic choices.
const settings = { model: { baseUrl: 'https://contact-model.example.test/v1', name: 'synthetic-contact-model', apiKey: 'synthetic-contact-key' } };
const profile = { ...initialProfile(), project: '商品素材助手', scenario: '线上店铺', features: ['生成主图', '生成文案'],
  inputs: '商品照片', outputs: '主图和详情页文案', integrations: '不自动发布' };
const state = { summaryVersion: 4, summaryReady: true, summaryConfirmed: true, quote: null,
  feedback: 'not_quoted', knowledgeStatus: 'not_configured', hasNewAttachments: false,
  contactAvailable: false, contactConsented: false, contactFields: [] };
const email = 'visitor@example.test';
const user = { id: 'synthetic-contact', role: 'user', content: `这是我的邮箱 ${email}，方便同事发评估结果给我。` };
const invitation = { id: 'synthetic-invitation', role: 'assistant', content: '同事会继续评估方案，可以留一种自己的联系方式，方便项目跟进。' };
function intake(type = 'respond', message = user, current = state, extra = {}) {
  return { type, summaryVersion: current.summaryVersion, quoteVersion: current.quote?.version ?? null,
    sourceMessageId: message.id, evidence: message.content, scopeChanged: false, ...extra };
}
function save(message = user, fields = { email: { value: email, sourceMessageId: user.id, quote: email } }, consent = 'granted') {
  return { type: 'save', sourceMessageId: message.id, evidence: message.content, fields, consent };
}
function model(values, calls = []) {
  return async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify(values[Math.min(calls.length - 1, values.length - 1)]),
    } }] }), { headers: { 'content-type': 'application/json' } });
  };
}
const answer = (contactAction = save(), extra = {}) => ({ profile: {}, action: intake(), contactAction,
  followUp: { acknowledgement: '', questions: [] }, ...extra });
const generate = (values, overrides = {}) => generateReply({ settings, profile, messages: [invitation, user],
  conversationState: state, fetchImpl: model(values), ...overrides });

test('contact Skill and state metadata enter the request while values remain only in their actual user source', async () => {
  const calls = [];
  const result = await generate([], { conversationState: { ...state, contact: { email: 'hidden-stored@example.test' }, contactValue: 'private-previous-value' },
    fetchImpl: model([answer()], calls) });
  assert.equal(result.degraded, false);
  assert.deepEqual(result.contactAction, save());
  assert.deepEqual(result.profile, profile);
  assert.equal(result.action.type, 'respond');
  assert.equal(result.reply, '', 'the caller must supply the actual execution receipt');
  assert.equal(result.diagnostics.skill.version, '1.2.0');
  const requestState = JSON.parse(calls[0].messages[1].content).conversationState;
  assert.deepEqual(requestState, state);
  assert.doesNotMatch(calls[0].messages[1].content, /hidden-stored|private-previous-value/);
  assert.match(calls[0].messages[0].content, /独立.*contactAction/);
  assert.match(calls[0].messages[0].content, /不按固定关键词匹配/);
  assert.match(calls[0].messages[0].content, /第三方|别人/);
  assert.match(calls[0].messages[0].content, /执行回执由服务端生成/);
  assert.equal(result.contact, undefined); assert.equal(result.contactConsent, undefined);
  assert.equal(result.contactReviewRequired, undefined);
});

test('a valid contact respond may omit follow-up or leave it null or empty for a factual server receipt', async t => {
  for (const [label, extra] of [['omitted', { followUp: undefined }], ['null', { followUp: null }],
    ['empty', { followUp: { acknowledgement: '', questions: [] } }]]) {
    await t.test(label, async () => {
      const result = await generate([answer(save(), extra)]);
      assert.equal(result.degraded, false); assert.equal(result.reply, '');
      assert.deepEqual(result.contactAction, save()); assert.equal(result.action.type, 'respond');
    });
  }
});

test('respond without an actual contact action still requires a normal response', async t => {
  for (const value of [null, undefined]) await t.test(String(value), async () => {
    const calls = [];
    const result = await generate([], { fetchImpl: model([answer(value, { contactAction: value })], calls) });
    assert.equal(result.degraded, true); assert.equal(result.contactAction, undefined);
    assert.equal(result.contactReviewRequired, undefined, 'absent contact intent must not create a review hold');
    assert.deepEqual(result.diagnostics.repairReasons, ['invalid_follow_up', 'invalid_follow_up']);
    assert.equal(calls.length, 2);
  });
});

test('one response can propose both summary confirmation and registration without fabricating either execution', async () => {
  const message = { ...user, content: `需求确认，邮箱是 ${email}，请同事继续联系我。` };
  const current = { ...state, summaryConfirmed: false };
  const result = await generate([answer(save(message), { action: intake('confirm_requirements', message, current) })],
    { messages: [invitation, message], conversationState: current });
  assert.equal(result.degraded, false); assert.equal(result.action.type, 'confirm_requirements');
  assert.equal(result.contactAction.type, 'save'); assert.equal(result.reply, '');
  assert.equal(result.summaryConfirmed, undefined); assert.equal(result.contactConsent, undefined);
});

test('quote feedback and contact intent remain independent, including accepted reference prices', async () => {
  const message = { ...user, content: `这个参考区间可以接受，邮箱是 ${email}，请联系我。` };
  const current = { ...state, quote: { min: 12000, max: 18000, currency: 'CNY', version: 4 },
    knowledgeStatus: 'quoted', feedback: 'pending' };
  const result = await generate([answer(save(message), { action: intake('quote_feedback', message, current, { feedback: 'accepted' }) })],
    { messages: [message], conversationState: current });
  assert.equal(result.degraded, false); assert.equal(result.action.feedback, 'accepted');
  assert.equal(result.contactAction.consent, 'granted'); assert.equal(result.quote, undefined); assert.equal(result.reply, '');
});

test('a contact action can accompany grounded scope revision without preserving the stale summary', async () => {
  const message = { ...user, content: `输出改成营销长图，我的邮箱是 ${email}，请联系我。` };
  const result = await generate([answer(save(message), { profile: { outputs: '营销长图' },
    evidence: { outputs: { source: `message:${message.id}`, quote: '营销长图' } },
    action: intake('continue', message, state, { scopeChanged: true }) })], { messages: [message] });
  assert.equal(result.degraded, false); assert.equal(result.action.type, 'continue'); assert.equal(result.action.scopeChanged, true);
  assert.equal(result.profile.outputs, '营销长图'); assert.equal(result.contactAction.type, 'save');
  assert.match(result.reply, /待你确认/); assert.doesNotMatch(result.reply, /已登记|已通知/);
});

test('contact intent does not make an incomplete continue ready or excuse missing questions', async () => {
  const current = { ...state, summaryReady: false, summaryConfirmed: false };
  const calls = [];
  const result = await generate([], { profile: initialProfile(), conversationState: current,
    fetchImpl: model([answer(save(), { action: intake('continue', user, current) })], calls) });
  assert.equal(result.degraded, true); assert.equal(result.ready, false); assert.equal(result.contactAction, undefined);
  assert.equal(result.contactReviewRequired, true, 'a valid contact action was not returned for execution');
  assert.deepEqual(result.diagnostics.repairReasons, ['incomplete_grounded_profile', 'incomplete_grounded_profile']);
  assert.equal(calls.length, 2);
  const withQuestion = await generate([answer(save(), { action: intake('continue', user, current),
    followUp: { acknowledgement: '收到你的补充啦。', questions: ['这个项目主要希望完成什么工作？'] } })],
    { profile: initialProfile(), conversationState: current });
  assert.equal(withQuestion.degraded, false); assert.equal(withQuestion.ready, false);
  assert.equal(withQuestion.contactAction.type, 'save'); assert.match(withQuestion.reply, /主要希望完成什么工作/);
});

test('later consent can use verified prior user fields or the available registration without exposing stored values', async () => {
  const consent = { id: 'synthetic-consent-later', role: 'user', content: '就用我上面留的邮箱，方便同事继续沟通。' };
  const fromHistory = await generate([answer(save(consent), { action: intake('respond', consent) })], { messages: [user, invitation, consent] });
  assert.equal(fromHistory.degraded, false); assert.equal(fromHistory.contactAction.fields.email.sourceMessageId, user.id);
  const current = { ...state, contactAvailable: true, contactConsented: false, contactFields: ['email'] };
  const existing = await generate([answer(save(consent, {}), { action: intake('respond', consent, current) })],
    { messages: [consent], conversationState: current });
  assert.equal(existing.degraded, false); assert.deepEqual(existing.contactAction.fields, {});
  const missing = await generate([answer(save(consent, {}), { action: intake('respond', consent) })], { messages: [consent] });
  assert.equal(missing.degraded, true); assert.equal(missing.contactAction, undefined);
});

test('unknown intent and explicit withdrawal have separate execution actions', async () => {
  const uncertain = await generate([answer(save(user, undefined, 'unknown'), {
    followUp: { acknowledgement: '', questions: ['方便同事就这个项目联系你吗？'] },
  })]);
  assert.equal(uncertain.degraded, false); assert.equal(uncertain.contactAction.consent, 'unknown');
  assert.match(uncertain.reply, /方便同事/);
  const message = { id: 'synthetic-withdraw', role: 'user', content: '先别让同事联系我了，我还需要想一想。' };
  const withdrawal = { type: 'withdraw', sourceMessageId: message.id, evidence: message.content };
  const result = await generate([answer(withdrawal, { action: intake('respond', message) })], { messages: [message] });
  assert.equal(result.degraded, false); assert.deepEqual(result.contactAction, withdrawal); assert.equal(result.reply, '');
});

test('invalid contact actions get one bounded correction with original context and no execution result on failure', async t => {
  const cases = [
    ['false action', false], ['empty string', ''], ['zero', 0], ['array', []],
    ['unrecognized operation', { ...save(), type: 'notify_now' }],
    ['fragment intent', { ...save(), evidence: email }],
    ['wrong latest message', { ...save(), sourceMessageId: 'old-id' }],
    ['invented contact', save(user, { email: { value: 'invented@example.test', sourceMessageId: user.id, quote: email } })],
    ['assistant source', save(user, { email: { value: email, sourceMessageId: invitation.id, quote: email } })],
    ['permission shortcut', { ...save(), notify: true }],
  ];
  for (const [label, value] of cases) await t.test(label, async () => {
    const calls = [];
    const result = await generate([], { fetchImpl: model([answer(value)], calls) });
    assert.equal(result.degraded, true); assert.equal(result.contactAction, undefined); assert.equal(result.action, undefined);
    assert.equal(result.contactReviewRequired, true);
    assert.equal(calls.length, 2); assert.deepEqual(result.diagnostics.repairReasons, ['invalid_contact_action', 'invalid_contact_action']);
    const correction = JSON.parse(calls[1].messages.at(-1).content).validation;
    assert.equal(correction.reason, 'invalid_contact_action'); assert.ok(correction.contactActionError);
    assert.deepEqual(calls[0].messages[1], calls[1].messages[1]);
    assert.doesNotMatch(result.reply, /已登记|已通知|example\.test/);
  });
  const calls = [];
  const repaired = await generate([], { fetchImpl: model([answer({ ...save(), evidence: email }), answer()], calls) });
  assert.equal(repaired.degraded, false); assert.deepEqual(repaired.contactAction, save());
  assert.equal(repaired.contactReviewRequired, undefined);
  assert.equal(calls.length, 2); assert.deepEqual(repaired.diagnostics.repairReasons, ['invalid_contact_action']);
});

test('contact-only respond does not allow malformed follow-up payloads or bypass requirement action checks', async () => {
  for (const followUp of [false, {}, { questions: 'bad' }]) {
    const result = await generate([answer(save(), { followUp })]);
    assert.equal(result.degraded, true); assert.equal(result.contactAction, undefined);
    assert.equal(result.contactReviewRequired, true);
  }
  const invalidVersion = await generate([answer(save(), { action: { ...intake(), summaryVersion: 3 } })]);
  assert.equal(invalidVersion.degraded, true); assert.equal(invalidVersion.contactAction, undefined);
  assert.equal(invalidVersion.contactReviewRequired, true);
});

test('repair cannot erase a failed contact action into a success claim or an ordinary response', async t => {
  const invalid = answer({ ...save(), evidence: email });
  const cases = [
    ['omitted action with a success claim', { contactAction: undefined, followUp: { acknowledgement: '联系方式记下啦。', questions: [] } }],
    ['null without clarification', { contactAction: null, followUp: { acknowledgement: '好的。', questions: [] } }],
    ['omitted action even with a question', { contactAction: undefined, followUp: { acknowledgement: '', questions: ['方便同事就这个项目联系你吗？'] } }],
    ['null with an invalid question', { contactAction: null, followUp: { acknowledgement: '好的。', questions: ['x'] } }],
  ];
  for (const [label, extra] of cases) await t.test(label, async () => {
    const calls = [];
    const result = await generate([], { fetchImpl: model([invalid, answer(null, extra)], calls) });
    assert.equal(result.degraded, true); assert.equal(result.contactAction, undefined); assert.equal(result.action, undefined);
    assert.equal(result.contactReviewRequired, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(result.diagnostics.repairReasons, ['invalid_contact_action', 'invalid_contact_action']);
    assert.doesNotMatch(result.reply, /记下|已登记|已通知/);
  });
  const calls = [];
  const clarified = await generate([], { fetchImpl: model([invalid, answer(null, {
    followUp: { acknowledgement: '我需要核实一下。', questions: ['方便同事就这个项目联系你吗？'] },
  })], calls) });
  assert.equal(clarified.degraded, false); assert.equal(clarified.contactAction, undefined);
  assert.equal(clarified.contactReviewRequired, true, 'asking about intent does not restore old permission');
  assert.equal(clarified.action.type, 'respond'); assert.match(clarified.reply, /方便同事/);
  assert.deepEqual(clarified.diagnostics.repairReasons, ['invalid_contact_action']);
  assert.equal(calls.length, 2);
});

test('contact repair failure preserves accepted scope facts but exposes no executable actions or false receipt', async () => {
  const message = { ...user, content: `输出改成营销长图，我的邮箱是 ${email}，请联系我。` };
  const action = intake('continue', message, state, { scopeChanged: true });
  const first = answer({ ...save(message), evidence: email }, { profile: { outputs: '营销长图' }, action,
    evidence: { outputs: { source: `message:${message.id}`, quote: '营销长图' } } });
  const second = { profile: {}, action, followUp: { acknowledgement: '联系方式记下啦。', questions: [] } };
  const calls = [];
  const result = await generate([], { messages: [message], fetchImpl: model([first, second], calls) });
  assert.equal(result.degraded, true); assert.equal(result.profile.outputs, '营销长图');
  assert.equal(result.ready, false); assert.equal(result.action, undefined); assert.equal(result.contactAction, undefined);
  assert.equal(result.contactReviewRequired, true);
  assert.deepEqual(result.diagnostics.repairReasons, ['invalid_contact_action', 'invalid_contact_action']);
  assert.equal(calls.length, 2); assert.doesNotMatch(result.reply, /记下|已登记|已通知/);
});

test('optional contact state rejects invalid shapes before transport and old calls remain compatible', async () => {
  let called = false;
  for (const override of [{ contactAvailable: 'yes' }, { contactConsented: 1 }, { contactFields: ['email', 'email'] },
    { contactFields: ['token'] }, { contactFields: email }]) {
    const result = await generate([], { conversationState: { ...state, ...override }, fetchImpl: async () => { called = true; } });
    assert.equal(result.reason, 'invalid_conversation_state'); assert.equal(result.degraded, true);
  }
  assert.equal(called, false);
  const legacy = await generateReply({ settings, profile, fetchImpl: model([{ profile: {}, followUp: { acknowledgement: '', questions: [] } }]) });
  assert.equal(legacy.degraded, false); assert.equal(legacy.ready, true); assert.equal(legacy.contactAction, undefined);
});

test('contact review is internal and cannot be set or suppressed by model fields', async () => {
  const ordinary = await generate([answer(null, { contactReviewRequired: true,
    followUp: { acknowledgement: '我可以继续帮你梳理项目。', questions: [] } })]);
  assert.equal(ordinary.degraded, false);
  assert.equal(ordinary.contactReviewRequired, undefined);
  const failed = await generate([answer({ ...save(), evidence: email }, { contactReviewRequired: false })]);
  assert.equal(failed.degraded, true);
  assert.equal(failed.contactReviewRequired, true);
  const executable = await generate([answer(save(), { contactReviewRequired: true })]);
  assert.equal(executable.degraded, false);
  assert.equal(executable.contactReviewRequired, undefined);
});

test('explicit contact clarification can continue requirement discovery while keeping contact under review', async () => {
  const message = { ...user, content: `输出改成营销长图，我的邮箱是 ${email}，请联系我。` };
  const action = intake('continue', message, state, { scopeChanged: true });
  const result = await generate([
    answer({ ...save(message), evidence: email }, { action, profile: { outputs: '营销长图' } }),
    answer(null, { action, followUp: { acknowledgement: '已了解长图这个需求。', questions: ['方便同事就这个项目联系你吗？'] } }),
  ], { messages: [message] });
  assert.equal(result.degraded, false);
  assert.equal(result.action.type, 'continue');
  assert.equal(result.profile.outputs, '营销长图');
  assert.equal(result.contactAction, undefined);
  assert.equal(result.contactReviewRequired, true);
  assert.match(result.reply, /方便同事/);
});

test('a valid contact proposal lost to another validation failure remains under review on retry', async () => {
  const first = answer(save(), { action: { ...intake(), summaryVersion: 3 } });
  const corrected = await generate([first, answer(null, {
    followUp: { acknowledgement: '我可以继续帮你梳理项目。', questions: [] },
  })]);
  assert.equal(corrected.degraded, false);
  assert.equal(corrected.contactAction, undefined);
  assert.equal(corrected.contactReviewRequired, true);
  assert.deepEqual(corrected.diagnostics.repairReasons, ['invalid_action']);
});

test('only successfully returned save or withdrawal actions clear a previous failed contact attempt', async t => {
  for (const action of [save(), save(user, undefined, 'unknown'),
    { type: 'withdraw', sourceMessageId: user.id, evidence: user.content }]) {
    await t.test(`${action.type}-${action.consent || 'withdraw'}`, async () => {
      const result = await generate([answer({ ...save(), evidence: email }), answer(action)]);
      assert.equal(result.degraded, false);
      assert.deepEqual(result.contactAction, action);
      assert.equal(result.contactReviewRequired, undefined);
    });
  }
});

test('parsed contact operations survive malformed requirement response structure as a review signal', async t => {
  for (const proposed of [save(), { ...save(), evidence: email }]) {
    await t.test(proposed.evidence === email ? 'invalid contact' : 'valid contact', async () => {
      const result = await generate([answer(proposed, { profile: null })]);
      assert.equal(result.degraded, true);
      assert.equal(result.contactAction, undefined);
      assert.equal(result.contactReviewRequired, true);
      assert.deepEqual(result.diagnostics.repairReasons, ['invalid_structure', 'invalid_structure']);
    });
  }
});

test('transport failure and timeout after a contact proposal preserve review without exposing an action', async t => {
  for (const kind of ['error', 'timeout']) {
    await t.test(kind, async () => {
      let calls = 0;
      const result = await generate([], { timeoutMs: 500, fetchImpl: async (...args) => {
        calls++;
        if (calls === 1) return model([answer({ ...save(), evidence: email })])(...args);
        if (kind === 'error') throw new Error('synthetic transport failure');
        return new Promise(() => {});
      } });
      assert.equal(calls, 2);
      assert.equal(result.degraded, true);
      assert.equal(result.contactAction, undefined);
      assert.equal(result.contactReviewRequired, true);
      assert.equal(result.reason, kind === 'timeout' ? 'model_timeout' : 'model_unavailable');
    });
  }
  const generic = await generate([], { fetchImpl: async () => { throw new Error('synthetic transport failure'); } });
  assert.equal(generic.degraded, true);
  assert.equal(generic.contactReviewRequired, undefined, 'an unobserved contact operation cannot be inferred');
});
