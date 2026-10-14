import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, initialProfile, isProfileReady, retrieveQuote } from '../server/intelligence.js';

// Synthetic facts and transport mocks only; no configured services or customer
// records are read by these recovery and evidence-boundary checks.
const settings = {
  model: { baseUrl: 'https://recovery-model.example.test/v1', name: 'synthetic-recovery-model', apiKey: 'synthetic-recovery-secret' },
  knowledge: { url: 'https://recovery-kb.example.test/search', apiKey: 'synthetic-knowledge-secret' },
  wecom: { webhook: 'https://recovery-notify.example.test/synthetic-secret' },
};
const scopedProfile = {
  ...initialProfile(), project: '给店铺生成商品图片和文案的助手', scenario: '线上店铺',
  features: ['生成商品图片', '生成文案'], inputs: '商品照片', outputs: '营销长图', integrations: '不自动发布',
};
const scopedMessage = {
  id: 'synthetic-scope', role: 'user',
  content: '给店铺生成商品图片和文案的助手，用于线上店铺，功能是生成商品图片和生成文案，输入商品照片，输出营销长图，不自动发布。',
};
const noQuestions = { acknowledgement: '收到啦，我先整理已明确的范围。', questions: [] };
const materialQuestion = '准备交给助手的商品素材具体有哪些？';
const jsonResponse = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const modelResponse = value => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
function sequence(responses, calls = []) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), signal: options.signal });
    const response = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof response === 'function' ? response(url, options) : modelResponse(response);
  };
}
function repairData(body) {
  const message = body.messages.at(-1);
  assert.equal(message.role, 'user', 'customer facts remain data rather than being promoted to system instructions');
  assert.equal(body.messages.at(-2).role, 'system');
  return JSON.parse(message.content).validation;
}

test('a stated goal and concrete scope reach confirmation without inventing an unstated pain point', async () => {
  const calls = [];
  const result = await generateReply({ settings, messages: [scopedMessage], fetchImpl: sequence([
    { profile: scopedProfile, followUp: noQuestions },
  ], calls) });
  assert.equal(calls.length, 1);
  assert.equal(result.degraded, false);
  assert.equal(result.ready, true);
  assert.equal(result.profile.problem, '');
  assert.match(result.reply, /待你确认|这份理解是否准确/);
  assert.doesNotMatch(result.reply, /要解决的问题：|节省时间|提高效率|最终报价为/);
  assert.equal(result.summaryConfirmed, undefined);
  assert.equal(result.quote, undefined);

  let knowledgeCalls = 0;
  const quote = await retrieveQuote({ settings, profile: result.profile, version: 2, fetchImpl: async () => {
    knowledgeCalls++;
    return jsonResponse({ cases: [] });
  } });
  assert.equal(knowledgeCalls, 1, 'the same readiness rule must also admit the confirmed scope to the knowledge adapter');
  assert.equal(quote.status, 'no_match');
  assert.equal(quote.quote, null);
});

test('a bare affirmative cannot replace the goal or a concrete input description', async () => {
  assert.equal(isProfileReady({ ...scopedProfile, project: '是的' }), false);
  assert.equal(isProfileReady({ ...scopedProfile, inputs: '都能提供' }), false);
  assert.equal(isProfileReady({ ...scopedProfile, project: '', problem: '手工处理商品资料耗时' }), true);
  const calls = [];
  const result = await generateReply({ settings, profile: { ...scopedProfile, project: '是的' },
    fetchImpl: sequence([{ profile: {}, followUp: noQuestions }], calls) });
  assert.equal(calls.length, 2);
  assert.equal(result.ready, false);
  assert.equal(result.degraded, true);
  assert.doesNotMatch(result.reply, /这份理解是否准确/);
});

test('one bounded repair uses accepted facts and gaps without replaying unsafe model prose or credentials', async () => {
  const calls = [];
  const added = { id: 'synthetic-new-output', role: 'user', content: '输出用营销长图，不自动发布。' };
  const previous = { ...scopedProfile, inputs: '', outputs: '', integrations: '' };
  const result = await generateReply({ settings, profile: previous, messages: [added], fetchImpl: sequence([
    { profile: { outputs: '营销长图', integrations: '不自动发布' },
      followUp: { acknowledgement: '收到啦。', questions: ['我们最终报价为 76543 元，你接受 UNSAFE_REPAIR_SENTINEL 吗？'] } },
    { profile: {}, followUp: { acknowledgement: '图片形式和发布边界已了解，我再确认素材。', questions: [materialQuestion] } },
  ], calls) });
  assert.equal(calls.length, 2);
  assert.equal(result.ready, false);
  assert.equal(result.degraded, false);
  assert.equal(result.profile.outputs, '营销长图');
  assert.equal(result.profile.integrations, '不自动发布');
  assert.match(result.reply, /商品素材具体有哪些/);
  const repair = repairData(calls[1].body);
  assert.equal(repair.acceptedProfile.outputs, '营销长图');
  assert.equal(repair.acceptedProfile.integrations, '不自动发布');
  assert.ok(repair.missingFields.includes('inputs'));
  assert.equal(repair.reason, 'invalid_follow_up');
  const repairBody = JSON.stringify(calls[1].body);
  assert.doesNotMatch(repairBody, /UNSAFE_REPAIR_SENTINEL|76543|synthetic-recovery-secret|synthetic-knowledge-secret|recovery-notify/);
  assert.deepEqual(calls[1].body.messages.slice(0, 2), calls[0].body.messages);
});

test('repair failure retains newly accepted facts and never starts a third request', async t => {
  for (const [label, second] of [
    ['transport error', async () => { throw new Error('private transport details'); }],
    ['invalid follow-up again', { profile: {}, followUp: { questions: ['我们保证三天交付，你接受吗？'] } }],
    ['malformed model response', async () => jsonResponse({ choices: [{ message: { content: 'not JSON' } }] })],
  ]) await t.test(label, async () => {
    const calls = [];
    const result = await generateReply({ settings, profile: { ...scopedProfile, inputs: '', outputs: '' },
      messages: [{ id: 'new-fact', role: 'user', content: '输出营销长图。' }], fetchImpl: sequence([
        { profile: { outputs: '营销长图' }, followUp: noQuestions }, second,
      ], calls) });
    assert.equal(calls.length, 2);
    assert.equal(result.profile.outputs, '营销长图');
    assert.equal(result.profile.inputs, '');
    assert.equal(result.ready, false);
    assert.equal(result.degraded, true);
    assert.doesNotMatch(result.reply, /private transport details|保证三天交付|这份理解是否准确/);
  });
});

test('both attempts share the original deadline and timeout keeps the first accepted facts', async () => {
  const calls = [];
  const started = performance.now();
  const result = await generateReply({ settings, timeoutMs: 500, profile: { ...scopedProfile, inputs: '', outputs: '' },
    messages: [{ id: 'timed-new-fact', role: 'user', content: '输出营销长图。' }], fetchImpl: sequence([
      async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return modelResponse({ profile: { outputs: '营销长图' }, followUp: noQuestions });
      },
      () => new Promise(() => {}),
    ], calls) });
  const elapsed = performance.now() - started;
  assert.equal(calls.length, 2);
  assert.equal(result.reason, 'model_timeout');
  assert.equal(result.ready, false);
  assert.equal(result.degraded, true);
  assert.equal(result.profile.outputs, '营销长图');
  assert.equal(calls[1].signal.aborted, true);
  assert.ok(elapsed < 700, `shared 500 ms deadline took ${Math.round(elapsed)} ms; each attempt must not receive another full deadline`);
});

test('separate customer quotes can form one explicitly evidenced field without paraphrasing', async () => {
  const calls = [];
  const result = await generateReply({ settings, profile: { ...scopedProfile, inputs: '' }, messages: [
    { id: 'material-one', role: 'user', content: '有商品照片。' },
    { id: 'material-two', role: 'user', content: '另外提供规格表。' },
  ], fetchImpl: sequence([{
    profile: { inputs: '商品照片；规格表' }, evidence: { inputs: [
      { source: 'message:material-one', quote: '商品照片' },
      { source: 'message:material-two', quote: '规格表' },
    ] }, followUp: noQuestions,
  }], calls) });
  assert.equal(calls.length, 1);
  assert.equal(result.degraded, false);
  assert.equal(result.ready, true);
  assert.equal(result.profile.inputs, '商品照片；规格表');
  assert.match(result.reply, /输入资料：商品照片；规格表/);
});

test('multi-source evidence refuses assistant suggestions, invented quotes, and rewritten joins', async t => {
  const messages = [
    { id: 'customer-photo', role: 'user', content: '商品照片。' },
    { id: 'assistant-option', role: 'assistant', content: '还需要加入规格表吗？' },
  ];
  const cases = [
    ['assistant source', '商品照片；规格表', [{ source: 'message:customer-photo', quote: '商品照片' }, { source: 'message:assistant-option', quote: '规格表' }]],
    ['unsupported quote', '商品照片；规格表', [{ source: 'message:customer-photo', quote: '商品照片' }, { source: 'message:customer-photo', quote: '规格表' }]],
    ['free paraphrase', '清晰的商品照片；商品规格表', [{ source: 'message:customer-photo', quote: '商品照片' }, { source: 'message:customer-photo', quote: '商品照片' }]],
  ];
  for (const [label, inputs, evidence] of cases) await t.test(label, async () => {
    const result = await generateReply({ settings, profile: { ...scopedProfile, inputs: '' }, messages,
      fetchImpl: sequence([{ profile: { inputs }, evidence: { inputs: evidence },
        followUp: { acknowledgement: '我再确认一下素材。', questions: [materialQuestion] } }]) });
    assert.equal(result.profile.inputs, '');
    assert.equal(result.ready, false);
    assert.doesNotMatch(result.reply, /清晰的商品照片|输入资料：.*规格表/);
  });
});

test('an earlier degraded assistant message does not prevent a later valid summary', async () => {
  const calls = [];
  const previous = { ...scopedProfile, outputs: '', integrations: '' };
  const result = await generateReply({ settings, profile: previous, messages: [
    scopedMessage,
    { id: 'old-degradation', role: 'assistant', content: '抱歉呀，这一轮我没能整理出可靠的下一步问题，你刚才的描述已经保留。' },
    { id: 'corrected-scope', role: 'user', content: '确认是营销长图，不自动发布。' },
  ], fetchImpl: sequence([{ profile: { outputs: '营销长图', integrations: '不自动发布' }, followUp: noQuestions }], calls) });
  assert.equal(calls.length, 1);
  assert.equal(result.ready, true);
  assert.equal(result.degraded, false);
  assert.equal(result.profile.problem, '');
  assert.match(result.reply, /待你确认/);
  assert.doesNotMatch(result.reply, /没能整理出可靠/);
});

test('repair cannot silently drop a rejected change and confirm an apparently complete old scope', async () => {
  const calls = [];
  const result = await generateReply({ settings, profile: scopedProfile,
    messages: [{ id: 'unresolved-addition', role: 'user', content: '新增规格表作为输入。' }], fetchImpl: sequence([
      { profile: { inputs: '商品照片和完整的规格资料表' }, followUp: noQuestions },
      { profile: {}, followUp: noQuestions },
    ], calls) });
  assert.equal(calls.length, 2);
  assert.ok(repairData(calls[1].body).rejectedFields.includes('inputs'));
  assert.equal(result.profile.inputs, '商品照片');
  assert.equal(result.ready, false);
  assert.equal(result.degraded, true);
  assert.doesNotMatch(result.reply, /这份理解是否准确/);
});

test('a repair can resolve a rejected paraphrase with explicit customer sources', async () => {
  const calls = [];
  const result = await generateReply({ settings, profile: scopedProfile, messages: [
    scopedMessage,
    { id: 'addition-with-source', role: 'user', content: '新增规格表作为输入。' },
  ], fetchImpl: sequence([
    { profile: { inputs: '商品照片和完整的规格资料表' }, followUp: noQuestions },
    { profile: { inputs: '商品照片；规格表' }, evidence: { inputs: [
      { source: 'message:synthetic-scope', quote: '商品照片' },
      { source: 'message:addition-with-source', quote: '规格表' },
    ] }, followUp: noQuestions },
  ], calls) });
  assert.equal(calls.length, 2);
  assert.equal(result.profile.inputs, '商品照片；规格表');
  assert.equal(result.ready, true);
  assert.equal(result.degraded, false);
  assert.match(result.reply, /待你确认/);
});
