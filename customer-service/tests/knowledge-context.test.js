import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { retrieveKnowledgeContext, resolveKnowledgeContextUrl } from '../server/knowledge-context.js';

// Synthetic inputs and local/mock transports only. These fixtures are not
// company cases, production credentials, or proof of real model connectivity.
const settings = {
  knowledge: { url: 'https://knowledge.example.test/api/integrations/customer-service/search', apiKey: 'synthetic-knowledge-secret' },
  model: { apiKey: 'synthetic-model-secret' },
  wecom: { webhook: 'https://group.example.test/synthetic-secret' },
};
const profile = {
  project: '合成售前助手', scenario: '商品咨询', problem: '咨询内容重复', features: ['商品问答', '整理咨询意向'],
  inputs: '商品文档', outputs: '答复和意向记录', integrations: '无额外对接',
};
const approvedCase = (overrides = {}) => ({
  id: 'synthetic-project#phase-one', title: '合成商品助手', summary: '先确认商品资料与答复边界；不承诺自动发布。',
  features: ['商品问答', '人工审核后交付'], approved: true, public: true, match: true,
  price: { min: 12000, max: 18000, currency: 'CNY' }, ...overrides,
});
const style = (overrides = {}) => ({ caseId: 'synthetic-project', topic: '范围表达', example: '先梳理资料和交付边界，再确认实施范围。', sourceFileId: 'private-file', ...overrides });
const context = (overrides = {}) => ({ status: 'ok', cases: [approvedCase()], styleReferences: [style()], priceEvidence: [{ amountMin: 12000 }], ...overrides });
const json = (body, options = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...options });
const retrieve = (body, options = {}) => retrieveKnowledgeContext({ settings, profile, fetchImpl: async () => json(body), ...options });

test('context endpoint is derived only from the administrator known contract without credentials, query, or fragments', () => {
  assert.equal(resolveKnowledgeContextUrl(settings.knowledge.url), 'https://knowledge.example.test/api/integrations/customer-service/context');
  assert.equal(resolveKnowledgeContextUrl('http://127.0.0.1:3220/proxy/api/integrations/customer-service/context'), 'http://127.0.0.1:3220/proxy/api/integrations/customer-service/context');
  for (const url of ['', 'invalid', 'https://third.example.test/search', 'https://third.example.test/api/integrations/customer-service/search/extra',
    'file:///api/integrations/customer-service/search', 'https://user:pass@knowledge.example.test/api/integrations/customer-service/search',
    settings.knowledge.url + '?secret=not-allowed', settings.knowledge.url + '#fragment', settings.knowledge.url + '?', settings.knowledge.url + '#']) {
    assert.equal(resolveKnowledgeContextUrl(url), null, url);
  }
});

test('unconfigured, unsupported, or empty scope makes no request', async () => {
  const fetchImpl = () => assert.fail('No request expected');
  assert.equal((await retrieveKnowledgeContext({ settings: {}, profile, fetchImpl })).status, 'not_configured');
  assert.equal((await retrieveKnowledgeContext({ settings: { knowledge: { url: 'https://custom.example.test/search' } }, profile, fetchImpl })).status, 'unsupported');
  assert.equal((await retrieveKnowledgeContext({ settings, profile: {}, fetchImpl })).status, 'no_match');
});

test('only scoped requirement fields are posted and integration credentials appear solely in the Authorization header', async () => {
  let request;
  const result = await retrieveKnowledgeContext({ settings, profile: { ...profile, budget: '9999', timeline: '明天',
    contact: { phone: 'synthetic-phone' }, messages: ['private full history'], token: 'private-token', deployment: 'not in contract' },
  fetchImpl: async (url, options) => { request = { url, options }; return json(context()); } });
  assert.equal(request.url, resolveKnowledgeContextUrl(settings.knowledge.url));
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, `Bearer ${settings.knowledge.apiKey}`);
  assert.deepEqual(JSON.parse(request.options.body).profile, profile);
  for (const secret of [settings.knowledge.apiKey, settings.model.apiKey, settings.wecom.webhook, 'synthetic-phone', 'private full history', '9999']) {
    assert.equal(request.options.body.includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(result, {
    status: 'ok', cases: [{ id: 'synthetic-project#phase-one', projectId: 'synthetic-project', title: '合成商品助手', summary: approvedCase().summary, features: approvedCase().features }],
    styleReferences: [{ caseId: 'synthetic-project', topic: style().topic, example: style().example }], sources: ['synthetic-project#phase-one'],
  });
});

test('unapproved, private, unmatched, and string approval values cannot authorize cases or their styles', async () => {
  for (const flag of ['approved', 'public', 'match']) {
    for (const value of [false, 'true', 1, null, undefined]) {
      const result = await retrieve(context({ cases: [approvedCase({ [flag]: value })] }));
      assert.deepEqual(result, { status: 'no_match', cases: [], styleReferences: [], sources: [] }, `${flag}:${value}`);
    }
  }
});

test('no-match and empty library ignore orphan styles and price metadata', async () => {
  for (const body of [context({ cases: [] }), context({ status: 'no_match' }), context({ status: 'no_match', cases: [] })]) {
    assert.deepEqual(await retrieve(body), { status: 'no_match', cases: [], styleReferences: [], sources: [] });
  }
});

test('styles must point to an accepted project id, not an unapproved project or phase id', async () => {
  const result = await retrieve(context({ styleReferences: [style(), style({ caseId: 'orphan' }), style({ caseId: 'synthetic-project#phase-one' })] }));
  assert.equal(result.styleReferences.length, 1);
  assert.equal(result.styleReferences[0].caseId, 'synthetic-project');
});

test('schema selection excludes raw documents, paths, internal prose, price evidence, and arbitrary metadata', async () => {
  const result = await retrieve(context({
    cases: [approvedCase({ raw: 'PRIVATE_RAW', internalSummary: 'PRIVATE_INTERNAL', sourcePath: 'D:\\private\\customer.docx' })],
    styleReferences: [style({ sourceFileId: 'PRIVATE_FILE_ID', sourcePath: 'PRIVATE_PATH', raw: 'PRIVATE_STYLE_RAW' })],
    priceEvidence: [{ caseId: 'synthetic-project', amountMin: 12000, sourceFileId: 'PRIVATE_QUOTE_FILE' }],
    nextUrl: 'https://attacker.example.test', private: 'PRIVATE_ROOT',
  }));
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(result).includes('price'), false);
  assert.equal(JSON.stringify(result).includes('12000'), false);
});

test('secret-bearing cases and style values are discarded rather than exposed', async () => {
  for (const secret of [settings.knowledge.apiKey, settings.model.apiKey, settings.wecom.webhook, encodeURIComponent(settings.wecom.webhook)]) {
    const result = await retrieve(context({ cases: [approvedCase({ summary: 'prefix ' + secret })], styleReferences: [style()] }));
    assert.equal(result.status, 'no_match');
    const safeCaseResult = await retrieve(context({ styleReferences: [style({ example: secret })] }));
    assert.equal(safeCaseResult.status, 'ok');
    assert.deepEqual(safeCaseResult.styleReferences, []);
    assert.equal(JSON.stringify(safeCaseResult).includes(secret), false);
  }
});

test('unknown or malformed response schemas fail closed without error-body echo', async () => {
  for (const body of [null, [], {}, { status: 'ok', cases: 'bad', styleReferences: [] }, { status: 'ok', cases: [], styleReferences: {} },
    { status: 'success', cases: [], styleReferences: [] }, context({ cases: Array(1001).fill(approvedCase()) })]) {
    const result = await retrieve(body);
    assert.deepEqual(result, { status: 'unavailable', cases: [], styleReferences: [], sources: [] });
  }
});

test('malformed case fields and overly long fields are never silently truncated', async () => {
  for (const overrides of [{ id: 'bad/path' }, { title: 3 }, { summary: {} }, { features: 'not-array' }, { features: [true] },
    { summary: '可交付。'.repeat(1000) + '最后声明不交付' }, { summary: 'line\u0000control' }]) {
    assert.equal((await retrieve(context({ cases: [approvedCase(overrides)] }))).status, 'no_match');
  }
  const result = await retrieve(context({ styleReferences: [style({ example: '安全范围。'.repeat(601) + '不交付自动执行' })] }));
  assert.deepEqual(result.styleReferences, []);
});

test('proposal channel rejects explicit monetary amounts without treating ordinary yuan words as money', async () => {
  for (const amount of ['参考价格12000元', '费用：5000', '报价为10000', 'CNY 12000', 'USD 200', '12000 CNY', '￥100', '$100', '一万元']) {
    assert.equal((await retrieve(context({ cases: [approvedCase({ summary: amount })] }))).status, 'no_match', amount);
    assert.deepEqual((await retrieve(context({ styleReferences: [style({ example: amount })] }))).styleReferences, [], amount);
  }
  for (const prose of ['提供多元化服务与页面元素管理', '整理美元汇率资料；不代客户交易。']) {
    assert.equal((await retrieve(context({ cases: [approvedCase({ summary: prose })] }))).status, 'ok', prose);
  }
});

test('caps projects and styles, deduplicates phases, and respects the total whole-item text budget', async () => {
  const cases = [approvedCase(), approvedCase({ id: 'synthetic-project#phase-two' }),
    ...Array.from({ length: 5 }, (_, i) => approvedCase({ id: `synthetic-${i}#phase` }))];
  const styleReferences = Array.from({ length: 12 }, (_, i) => style({ topic: `表达${i}` }));
  const result = await retrieve(context({ cases, styleReferences }));
  assert.equal(result.cases.length, 3);
  assert.equal(result.styleReferences.length, 6);
  assert.equal(new Set(result.cases.map(item => item.projectId)).size, 3);
  const longResult = await retrieve(context({ cases: Array.from({ length: 3 }, (_, i) => approvedCase({ id: `long-${i}`, summary: '甲'.repeat(3900), features: ['乙'.repeat(900)] })),
    styleReferences: [style({ caseId: 'long-0', example: '丙'.repeat(2900) })] }));
  assert.ok(JSON.stringify(longResult).length < 12_500);
  for (const candidate of longResult.cases) assert.equal(candidate.summary, '甲'.repeat(3900));
});

test('query limits preserve whole values and never send configured secrets', async () => {
  let body;
  await retrieve(context(), { profile: { ...profile, scenario: '甲'.repeat(801) + '不对接', inputs: settings.model.apiKey, features: ['正常', '乙'.repeat(301) + '不得执行'] },
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return json(context()); } });
  assert.equal('scenario' in body.profile, false);
  assert.equal('inputs' in body.profile, false);
  assert.equal('features' in body.profile, false);
  assert.equal(body.query.includes(settings.model.apiKey), false);
  assert.equal(body.query.includes('甲'), false);
});

test('obvious contact values embedded in scoped fields are omitted from the query', async () => {
  let body;
  await retrieve(context(), { profile: { ...profile, problem: '请联系 sample@example.test', inputs: '联系电话：13800000000', features: ['微信：synthetic_name'] },
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return json(context()); } });
  assert.equal('problem' in body.profile, false);
  assert.equal('inputs' in body.profile, false);
  assert.equal('features' in body.profile, false);
  assert.doesNotMatch(body.query, /example\.test|13800000000|synthetic_name/u);
});

test('request failures and unsuccessful HTTP responses return only unavailable', async () => {
  for (const fetchImpl of [async () => { throw new Error(settings.knowledge.apiKey); }, async () => json({ error: settings.model.apiKey }, { status: 401 }),
    async () => new Response('{bad-json:' + settings.knowledge.apiKey, { headers: { 'Content-Type': 'application/json' } }),
    async () => new Response(JSON.stringify(context()), { headers: { 'Content-Type': 'text/html' } })]) {
    assert.deepEqual(await retrieveKnowledgeContext({ settings, profile, fetchImpl }), { status: 'unavailable', cases: [], styleReferences: [], sources: [] });
  }
});

test('total deadline also stops a stalled body and does not hang when the transport ignores abort', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'Content-Type': 'application/json' } })]) {
    const start = Date.now();
    const result = await retrieveKnowledgeContext({ settings, profile, fetchImpl, timeoutMs: 20 });
    assert.equal(result.status, 'unavailable');
    assert.ok(Date.now() - start < 1000);
  }
});

test('oversized advertised and streamed responses are rejected', async () => {
  const advertised = await retrieve(context(), { fetchImpl: async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '2000001' } }) });
  assert.equal(advertised.status, 'unavailable');
  const streamed = await retrieve(context(), { fetchImpl: async () => new Response(' '.repeat(2_000_001), { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal(streamed.status, 'unavailable');
});

test('withdrawn cases disappear on the next request without a context cache', async () => {
  let count = 0;
  const fetchImpl = async () => json(++count === 1 ? context() : context({ status: 'no_match', cases: [], styleReferences: [] }));
  assert.equal((await retrieveKnowledgeContext({ settings, profile, fetchImpl })).status, 'ok');
  assert.deepEqual(await retrieveKnowledgeContext({ settings, profile, fetchImpl }), { status: 'no_match', cases: [], styleReferences: [], sources: [] });
  assert.equal(count, 2);
});

test('actual local HTTP follows the context contract and refuses redirect destinations', async t => {
  const requests = [];
  let redirect = false;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    if (redirect) { res.writeHead(302, { Location: '/unexpected' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(context()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const localSettings = { ...settings, knowledge: { ...settings.knowledge, url: `http://127.0.0.1:${server.address().port}/api/integrations/customer-service/search` } };
  assert.equal((await retrieveKnowledgeContext({ settings: localSettings, profile })).status, 'ok');
  assert.equal(requests[0].url, '/api/integrations/customer-service/context');
  assert.equal(requests[0].authorization, `Bearer ${settings.knowledge.apiKey}`);
  redirect = true;
  assert.equal((await retrieveKnowledgeContext({ settings: localSettings, profile })).status, 'unavailable');
  assert.equal(requests.length, 2);
  assert.equal(requests.some(request => request.url === '/unexpected'), false);
});
