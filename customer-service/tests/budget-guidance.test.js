import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { generateReply, initialProfile, retrieveQuote } from '../server/intelligence.js';
import { loadCustomerServiceSkill } from '../server/customer-service-skill.js';

// Synthetic scope and transport mocks only. Skill tests verify runtime loading,
// not actual model obedience or semantic quality; live checks remain separate.
const settings = { model: { baseUrl: 'https://skill-model.example.test/v1', name: 'synthetic-skill-model', apiKey: 'synthetic-skill-test-secret' } };
const fullProfile = { ...initialProfile(), project: '电商图文助手', scenario: '线上店铺',
  features: ['生成商品图', '生成文案'], inputs: '商品照片和参数表', outputs: '主图和详情页文案', integrations: '不自动发布' };
function model(value, calls = []) {
  return async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }),
      { headers: { 'content-type': 'application/json' } });
  };
}
const response = (questions = [], acknowledgement = '收到啦。', profile = {}) => ({ profile, followUp: { acknowledgement, questions } });

test('actual requests include the project Skill and only its metadata is returned in diagnostics', async () => {
  const bytes = readFileSync(new URL('../skills/customer-service/SKILL.md', import.meta.url));
  const calls = [];
  const result = await generateReply({ settings, profile: fullProfile, fetchImpl: model(response(), calls) });
  assert.equal(result.degraded, false); assert.equal(calls.length, 1);
  assert.ok(calls[0].messages[0].content.includes(bytes.toString('utf8')));
  assert.match(calls[0].messages[0].content, /活泼、亲切、有耐心/);
  assert.match(calls[0].messages[0].content, /不主动询问预算/);
  assert.match(calls[0].messages[0].content, /公司先评估报价/);
  assert.match(calls[0].messages[0].content, /同一个“好”在不同上下文/);
  assert.deepEqual(result.diagnostics.skill, { id: 'customer-service', version: '1.2.0', sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.doesNotMatch(JSON.stringify(result), /<customer-service-skill>|synthetic-skill-test-secret/);
});

test('Skill edits take effect on the next intake call without restarting the module', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'customer-service-skill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'server')); mkdirSync(path.join(root, 'skills', 'customer-service'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['intelligence.js', 'customer-service-skill.js', 'contact-actions.js', 'knowledge-context.js']) copyFileSync(new URL(`../server/${name}`, import.meta.url), path.join(root, 'server', name));
  const skillFile = path.join(root, 'skills', 'customer-service', 'SKILL.md');
  const first = '---\nname: customer-service\nmetadata:\n  version: 1.0.0\n---\n第一轮合成人设标记。';
  const second = '---\nname: customer-service\nmetadata:\n  version: 1.0.1\n---\n第二轮合成人设标记。';
  writeFileSync(skillFile, first);
  const { generateReply: isolated } = await import(pathToFileURL(path.join(root, 'server', 'intelligence.js')).href);
  const requests = [];
  const a = await isolated({ settings, profile: fullProfile, fetchImpl: model(response(), requests) });
  writeFileSync(skillFile, second);
  const b = await isolated({ settings, profile: fullProfile, fetchImpl: model(response(), requests) });
  assert.equal(a.degraded, false); assert.equal(b.degraded, false);
  assert.ok(requests[0].messages[0].content.includes(first)); assert.ok(requests[1].messages[0].content.includes(second));
  assert.equal(b.diagnostics.skill.version, '1.0.1'); assert.notEqual(a.diagnostics.skill.sha256, b.diagnostics.skill.sha256);
  rmSync(skillFile);
  const unavailable = await isolated({ settings, profile: fullProfile, fetchImpl: model(response(), requests) });
  assert.equal(unavailable.degraded, true); assert.equal(unavailable.reason, 'skill_unavailable');
  assert.equal(requests.length, 2, 'a missing Skill must not silently reuse a cached persona or invoke a model without it');
});

test('the loader rejects missing identity, version, body and oversized skill files', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'customer-service-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'SKILL.md');
  for (const content of ['', 'plain instructions', '---\nname: another-skill\nmetadata:\n  version: 1.0.0\n---\nbody',
    '---\nname: customer-service\n---\nbody', '---\nname: customer-service\nmetadata:\n  version: 1.0.0\n---\n', 'a'.repeat(65 * 1024)]) {
    writeFileSync(file, content); assert.throws(() => loadCustomerServiceSkill(file), /invalid_customer_service_skill/);
  }
});

test('budget and timing communication is Skill guidance, not silent runtime keyword filtering', async t => {
  for (const question of ['你的预算大概是多少？', '你能接受的价位是多少？', '项目的费用上限是多少？', '你希望什么时候上线？', '你希望上线时支持哪些平台？']) {
    await t.test(question, async () => {
      const result = await generateReply({ settings, profile: fullProfile, fetchImpl: model(response([question])) });
      assert.equal(result.degraded, false); assert.equal(result.ready, false); assert.ok(result.reply.includes(question));
    });
  }
});

test('complete scope without a customer budget can proceed to the summary', async () => {
  const result = await generateReply({ settings, profile: fullProfile,
    messages: [{ id: 'synthetic-no-budget', role: 'user', content: '我不懂行情，你们先评估报价。' }], fetchImpl: model(response()) });
  assert.equal(result.ready, true); assert.equal(result.degraded, false); assert.equal(result.profile.budget, '');
  assert.doesNotMatch(result.reply, /预算是多少|费用上限|可接受价位/);
  assert.match(result.reply, /由我们根据需求和公司案例先评估参考报价/);
  assert.match(result.reply, /缺少案例或价格依据时交同事评估/);
});

test('voluntary budget is retained as grounded intent and never grants a company quote', async () => {
  const message = { id: 'synthetic-voluntary', role: 'user', content: '我这边预算是5000元，你们依据需求先评估吧。' };
  const result = await generateReply({ settings, profile: fullProfile, messages: [message],
    fetchImpl: model({ ...response(), profile: { budget: '5000元' }, evidence: { budget: { source: `message:${message.id}`, quote: '5000元' } } }) });
  assert.equal(result.ready, true); assert.equal(result.profile.budget, '5000元');
  assert.match(result.reply, /客户预算意向（不等于报价）：5000元/); assert.equal(result.quote, undefined);
  const quote = await retrieveQuote({ settings, profile: result.profile, version: 1, fetchImpl: () => { throw new Error('unexpected knowledge request'); } });
  assert.equal(quote.status, 'not_configured'); assert.equal(quote.quote, null);
});
