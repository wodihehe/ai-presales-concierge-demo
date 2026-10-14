import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { openStore } from '../server/store.js';
import { createApp } from '../server/app.js';

// Explicitly synthetic HTTP state-flow tests. Semantic decisions, references,
// prices and notification transport are injected; no live service is called.
const scratch = fileURLToPath(new URL('../知识库/tests/.tmp/', import.meta.url));
const profile = {
  project: '[SYNTHETIC_FIXTURE] 商品素材助手', scenario: '店铺商品运营', problem: '',
  features: ['生成商品图', '生成商品文案'], inputs: '商品照片和参数表',
  outputs: '主图和详情长图', integrations: '不自动发布', budget: '', timeline: '',
};
const proposal = '参考已审核的相近方案，可以先梳理素材，再生成商品图与文案，最后交员工审核。具体范围仍需同事确认。';
const answer = '本次查到的方案示例将素材准备、内容生成和人工审核分别说明，便于逐项核对交付边界。';
const sourceA = 'synthetic-reviewed-case-a';
const sourceB = 'synthetic-reviewed-case-b';
const noReference = () => ({ status: 'no_match', reply: '', sources: [] });

function semantic(input, { type = 'respond', nextProfile, referenceRequested = false, reply = '收到你的消息啦。', ...extra } = {}) {
  const latest = input.messages.findLast(message => message.role === 'user');
  const state = input.conversationState;
  return {
    profile: structuredClone(nextProfile || input.profile), ready: state.summaryReady, degraded: false, reply,
    action: { type, summaryVersion: state.summaryVersion, quoteVersion: state.quote?.version ?? null,
      sourceMessageId: latest.id, evidence: latest.content, scopeChanged: type === 'continue' },
    referenceRequested, ...extra,
  };
}
function saveContact(input) {
  const latest = input.messages.findLast(message => message.role === 'user');
  return { type: 'save', sourceMessageId: latest.id, evidence: latest.content, consent: 'granted',
    fields: { email: { value: 'synthetic-reference@example.test', sourceMessageId: latest.id, quote: latest.content } } };
}
function setup(t, options = {}) {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(path.join(scratch, 'knowledge-replies-'));
  const store = openStore(dir), calls = { reference: [], quote: [], reply: [], delivery: [] }, scripts = [];
  const application = createApp(store, {
    rateLimits: false,
    replyFn: async input => {
      calls.reply.push(structuredClone(input));
      const script = scripts.shift();
      assert.ok(script, 'every model decision must be explicitly scripted');
      return script(input);
    },
    quoteFn: async input => {
      calls.quote.push(structuredClone(input));
      return options.quoteFn ? options.quoteFn(input) : { status: 'quoted',
        quote: { min: 12000, max: 18000, currency: 'CNY', version: input.version, note: '合成参考区间，最终由人工确认。' },
        sources: ['synthetic-price-case'] };
    },
    referenceFn: async input => {
      calls.reference.push(structuredClone(input));
      return options.referenceFn ? options.referenceFn(input) : { status: 'ok', reply: proposal, sources: [sourceA] };
    },
    fetchImpl: async (...args) => {
      calls.delivery.push(args);
      throw new Error('No enterprise notification may be sent by this test suite.');
    },
  });
  t.after(() => {
    assert.equal(calls.delivery.length, 0);
    store.close();
    // dir is generated under the task-owned scratch directory above.
    assert.equal(path.dirname(dir), path.normalize(scratch).replace(/[\\/]$/, ''));
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...application, store, calls, script: fn => scripts.push(fn) };
}
function body(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function visitor(env, { ready = true, confirmed = false } = {}) {
  const agent = request.agent(env.app), initial = body(await agent.get('/api/session')).conversation;
  const c = env.store.getConversation(initial.id);
  c.profile = structuredClone(profile); c.summaryVersion = 7;
  c.summaryReady = ready; c.summaryConfirmed = confirmed;
  env.store.saveConversation(c);
  return { agent, id: c.id, url: `/api/conversations/${c.id}`, serial: 0 };
}
async function confirm(client, version = 7) {
  return body(await client.agent.post(`${client.url}/confirm`).send({ version })).conversation;
}
async function send(env, client, content, script, overrides = {}) {
  env.script(script);
  return client.agent.post(`${client.url}/messages`).send({ content,
    summaryVersion: env.store.getConversation(client.id).summaryVersion,
    requestId: `synthetic-reference-${++client.serial}`, ...overrides });
}
async function admin(env) {
  const password = randomBytes(24).toString('base64url');
  env.store.createUser('synthetic_reference_admin', password, 'admin');
  const agent = request.agent(env.app);
  body(await agent.post('/api/admin/login').send({ username: 'synthetic_reference_admin', password }));
  return agent;
}
const messagesAfter = (c, count) => c.messages.slice(count).filter(m => m.role === 'assistant').map(m => m.content).join('\n');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('button and semantic confirmation generate a sourced proposal without changing the quote or customer facts', async t => {
  for (const method of ['button', 'text']) await t.test(method, async t => {
    const env = setup(t), client = await visitor(env);
    const c = method === 'button' ? await confirm(client)
      : body(await send(env, client, '这份需求准确，可以按这个范围评估。', input => semantic(input, { type: 'confirm_requirements' }))).conversation;
    assert.equal(c.summaryConfirmed, true);
    assert.equal(c.summaryVersion, 7);
    assert.deepEqual(c.profile, profile, 'historical reference is never a new customer requirement');
    assert.equal(c.quote.min, 12000); assert.equal(c.quote.max, 18000);
    assert.equal(c.quote.version, 7); assert.equal(c.knowledgeStatus, 'quoted');
    assert.ok(c.messages.some(m => m.role === 'assistant' && m.content.includes(proposal)));
    assert.equal(env.calls.reference.length, 1); assert.equal(env.calls.quote.length, 1);
    assert.equal(env.calls.reference[0].mode, 'proposal');
    assert.deepEqual(env.calls.reference[0].profile, profile);
    assert.deepEqual(env.store.getConversation(client.id).knowledgeReplySources, [sourceA]);
    assert.equal(c.knowledgeReplySources, undefined);
    assert.equal(c.quoteSources, undefined);
    assert.ok(c.messages.every(m => !Object.hasOwn(m, 'knowledgeReference')));
    assert.ok(!JSON.stringify(c).includes(sourceA), 'internal reference IDs must not leak through a nested public field');
  });
});

test('a same-type case can supply a proposal when no approved price is available', async t => {
  const env = setup(t, { quoteFn: async () => ({ status: 'no_price', quote: null, sources: ['synthetic-price-free-case'] }) });
  const client = await visitor(env), c = await confirm(client);
  assert.equal(c.quote, null); assert.equal(c.knowledgeStatus, 'no_price'); assert.equal(c.handoff, true);
  assert.ok(c.messages.some(m => m.content.includes(proposal)));
  assert.equal(env.calls.reference.length, 1);
});

test('button retries, HTTP message retries and repeated semantic confirmation do not regenerate a proposal', async t => {
  const env = setup(t), client = await visitor(env), first = await confirm(client);
  const buttonAgain = await confirm(client);
  assert.deepEqual(buttonAgain, first);
  const requestBody = { content: '还是刚才的范围，已经确认了。', summaryVersion: 7, requestId: 'synthetic-repeat-confirmation' };
  env.script(input => semantic(input, { type: 'confirm_requirements' }));
  const repeated = body(await client.agent.post(`${client.url}/messages`).send(requestBody)).conversation;
  const retried = body(await client.agent.post(`${client.url}/messages`).send(requestBody)).conversation;
  assert.deepEqual(retried, repeated);
  assert.equal(env.calls.reference.length, 1); assert.equal(env.calls.quote.length, 1); assert.equal(env.calls.reply.length, 1);
  assert.equal(repeated.messages.filter(m => m.content.includes(proposal)).length, 1);
  assert.deepEqual(repeated.quote, first.quote);
});

test('a confirmed reference question fetches fresh context and replaces only reference sources', async t => {
  const env = setup(t, { referenceFn: async input => input.mode === 'proposal'
    ? { status: 'ok', reply: proposal, sources: [sourceA] }
    : { status: 'ok', reply: answer, sources: [sourceB] } });
  const client = await visitor(env), confirmed = await confirm(client);
  const question = '我们这种项目通常怎样组织交付方案？';
  const c = body(await send(env, client, question, input => semantic(input, { referenceRequested: true }))).conversation;
  assert.equal(env.calls.reference.length, 2);
  assert.equal(env.calls.reference[1].mode, 'answer'); assert.equal(env.calls.reference[1].question, question);
  assert.deepEqual(env.calls.reference[1].profile, profile);
  assert.ok(messagesAfter(c, confirmed.messages.length).includes(answer));
  assert.deepEqual(c.quote, confirmed.quote); assert.equal(c.summaryVersion, 7); assert.equal(c.summaryConfirmed, true);
  assert.deepEqual(env.store.getConversation(client.id).knowledgeReplySources, [sourceB]);
  assert.deepEqual(env.store.getConversation(client.id).quoteSources, ['synthetic-price-case']);
  assert.equal(c.knowledgeReplySources, undefined); assert.ok(!JSON.stringify(c).includes(sourceB));
  assert.equal(env.calls.quote.length, 1);
});

test('fresh no-match and upstream failures never reuse an earlier proposal or remove its independent quote', async t => {
  for (const status of ['no_match', 'unavailable', 'not_configured', 'unsupported', 'model_unavailable', 'throws']) await t.test(status, async t => {
    const env = setup(t, { referenceFn: async input => {
      if (input.mode === 'proposal') return { status: 'ok', reply: proposal, sources: [sourceA] };
      if (status === 'throws') throw new Error('Synthetic upstream failure');
      return { status, reply: '', sources: [] };
    } });
    const client = await visitor(env), confirmed = await confirm(client);
    const c = body(await send(env, client, '现在还能参考哪个实施方案？', input => semantic(input,
      { referenceRequested: true, reply: proposal }))).conversation;
    const newText = messagesAfter(c, confirmed.messages.length);
    assert.equal(env.calls.reference.length, 2);
    assert.ok(newText.trim(), 'an unavailable reference produces an honest customer-facing response');
    assert.ok(!newText.includes(proposal), 'a model echo of old knowledge is not a replacement for fresh retrieval');
    assert.deepEqual(c.quote, confirmed.quote); assert.equal(c.knowledgeStatus, confirmed.knowledgeStatus);
    assert.equal(c.summaryConfirmed, true);
    assert.deepEqual(env.store.getConversation(client.id).knowledgeReplySources, []);
  });
});

test('failed initial reference generation leaves the confirmed price flow available', async t => {
  const env = setup(t, { referenceFn: async () => { throw new Error('Synthetic model outage'); } });
  const client = await visitor(env), c = await confirm(client);
  assert.equal(c.summaryConfirmed, true); assert.equal(c.quote.min, 12000); assert.equal(c.knowledgeStatus, 'quoted');
  assert.equal(env.calls.reference.length, 1); assert.equal(env.calls.quote.length, 1);
  assert.ok(c.messages.some(m => /参考区间/.test(m.content)));
  assert.deepEqual(env.store.getConversation(client.id).knowledgeReplySources, []);
});

test('unconfirmed questions and ordinary confirmed responses never trigger a knowledge answer', async t => {
  for (const scenario of [{ confirmed: false, referenceRequested: true }, { confirmed: true, referenceRequested: false }]) {
    await t.test(JSON.stringify(scenario), async t => {
      const env = setup(t), client = await visitor(env, scenario);
      const c = body(await send(env, client, '我还想了解后续怎么安排。', input => semantic(input, scenario))).conversation;
      assert.equal(env.calls.reference.length, 0); assert.equal(env.calls.quote.length, 0);
      assert.equal(c.summaryConfirmed, scenario.confirmed);
    });
  }
});

test('scope revisions invalidate reference sources and cannot request a proposal until the new scope is confirmed', async t => {
  const env = setup(t), client = await visitor(env); await confirm(client);
  const changed = { ...profile, features: [...profile.features, '生成短视频'], outputs: '主图、详情长图和短视频' };
  const revised = body(await send(env, client, '增加生成短视频，请按新范围重新考虑。', input => semantic(input,
    { type: 'continue', nextProfile: changed, referenceRequested: true, ready: true }))).conversation;
  assert.equal(revised.summaryConfirmed, false); assert.equal(revised.quote, null); assert.equal(revised.summaryVersion, 8);
  assert.deepEqual(env.store.getConversation(client.id).knowledgeReplySources, []);
  assert.equal(env.calls.reference.length, 1);
  const response = body(await send(env, client, '先讲讲新范围的方案。', input => semantic(input, { referenceRequested: true }))).conversation;
  assert.equal(response.summaryConfirmed, false); assert.equal(env.calls.reference.length, 1);
  const rechecked = await confirm(client, response.summaryVersion);
  assert.equal(rechecked.summaryConfirmed, true); assert.equal(env.calls.reference.length, 2);
  assert.deepEqual(env.calls.reference[1].profile, changed);
});

test('contact actions remain independent and suppress a competing reference answer', async t => {
  const env = setup(t), client = await visitor(env); const confirmed = await confirm(client);
  const c = body(await send(env, client, '我的邮箱是 synthetic-reference@example.test，请同事跟进并再讲讲方案。', input => semantic(input,
    { referenceRequested: true, contactAction: saveContact(input), reply: '没有真正执行的模型登记话术。' }))).conversation;
  assert.equal(env.calls.reference.length, 1);
  assert.equal(c.contactSubmitted, true); assert.deepEqual(c.quote, confirmed.quote); assert.equal(c.summaryConfirmed, true);
  assert.equal(env.store.getConversation(client.id).contact.email, 'synthetic-reference@example.test');
  assert.equal(env.store.notifications(client.id).filter(n => n.status !== 'superseded').length, 1);
  assert.match(c.messages.at(-1).content, /联系方式已登记|项目和联系方式已登记/);
  assert.doesNotMatch(c.messages.at(-1).content, /没有真正执行/);
});

test('a reference outage during combined confirmation and contact does not lose the contact action', async t => {
  const env = setup(t, { referenceFn: async () => { throw new Error('Synthetic reference failure'); } });
  const client = await visitor(env);
  const c = body(await send(env, client, '确认需求，我的邮箱是 synthetic-reference@example.test，请同事联系我。', input => semantic(input,
    { type: 'confirm_requirements', contactAction: saveContact(input) }))).conversation;
  assert.equal(c.summaryConfirmed, true); assert.equal(c.quote.min, 12000); assert.equal(c.contactSubmitted, true);
  assert.equal(env.store.getConversation(client.id).contact.consent, true);
  assert.equal(env.store.notifications(client.id).filter(n => n.status !== 'superseded').length, 1);
});

test('source IDs are available to the management API but absent from visitor reads and new conversations', async t => {
  const env = setup(t), client = await visitor(env); await confirm(client);
  const manager = await admin(env);
  const managed = body(await manager.get(`/api/admin/conversations/${client.id}`)).conversation;
  assert.deepEqual(managed.knowledgeReplySources, [sourceA]);
  for (const url of ['/api/session', client.url]) {
    const c = body(await client.agent.get(url)).conversation;
    assert.equal(c.knowledgeReplySources, undefined); assert.ok(!JSON.stringify(c).includes(sourceA));
  }
  const fresh = body(await client.agent.post('/api/conversations').send({})).conversation;
  assert.equal(fresh.summaryConfirmed, false); assert.equal(fresh.knowledgeReplySources, undefined);
  assert.ok(!JSON.stringify(fresh).includes(sourceA)); assert.ok(!JSON.stringify(fresh).includes(proposal));
});

test('deletion during an in-flight proposal or knowledge answer cannot resurrect the consultation', { timeout: 15000 }, async t => {
  for (const mode of ['proposal', 'answer']) await t.test(mode, { timeout: 6000 }, async t => {
    const entered = deferred(), release = deferred();
    const env = setup(t, { referenceFn: async input => {
      if (input.mode !== mode) return noReference();
      entered.resolve(); await release.promise;
      return { status: 'ok', reply: proposal, sources: [sourceA] };
    } });
    const client = await visitor(env, { confirmed: mode === 'answer' }), manager = await admin(env);
    let pending;
    if (mode === 'proposal') pending = client.agent.post(`${client.url}/confirm`).send({ version: 7 }).then(r => r);
    else pending = send(env, client, '说明一下参考方案。', input => semantic(input, { referenceRequested: true })).then(r => r);
    try {
      await entered.promise;
      body(await manager.delete(`/api/admin/conversations/${client.id}`));
    } finally { release.resolve(); }
    const response = await pending;
    assert.equal(response.status, 410, JSON.stringify(response.body));
    assert.equal(env.store.getConversation(client.id), null);
    assert.equal(env.store.notifications(client.id).length, 0);
    assert.equal(env.store.db.prepare('SELECT count(*) AS n FROM notification_holds WHERE conversation_id=?').get(client.id).n, 0);
    assert.equal((await client.agent.get(client.url)).status, 404);
  });
});

test('in-flight reference work keeps conflicting conversation writes locked until the result is saved', { timeout: 8000 }, async t => {
  const entered = deferred(), release = deferred();
  const env = setup(t, { referenceFn: async input => {
    if (input.mode === 'proposal') return { status: 'ok', reply: proposal, sources: [sourceA] };
    entered.resolve(); await release.promise;
    return { status: 'ok', reply: answer, sources: [sourceB] };
  } });
  const client = await visitor(env), confirmed = await confirm(client), manager = await admin(env);
  const pending = send(env, client, '能进一步说说已确认方案吗？', input => semantic(input, { referenceRequested: true })).then(r => r);
  try {
    await entered.promise;
    const responses = await Promise.all([
      client.agent.post(`${client.url}/confirm`).send({ version: 7 }),
      client.agent.post(`${client.url}/messages`).send({ content: '临时补充需求', requestId: 'synthetic-conflicting-write', summaryVersion: 7 }),
      client.agent.post(`${client.url}/contact`).send({ email: 'synthetic-conflict@example.test', consent: true }),
      client.agent.post(`${client.url}/feedback`).send({ feedback: 'accepted', version: 7 }),
      manager.patch(`/api/admin/conversations/${client.id}`).send({ followupStatus: 'following' }),
    ]);
    assert.ok(responses.every(response => response.status === 409));
    assert.equal(env.calls.reply.length, 1); assert.equal(env.calls.reference.length, 2);
    assert.equal(env.store.getConversation(client.id).contact, null);
  } finally { release.resolve(); }
  const c = body(await pending).conversation;
  assert.equal(c.summaryConfirmed, true); assert.deepEqual(c.quote, confirmed.quote);
  assert.equal(c.followupStatus, 'pending'); assert.equal(c.contactSubmitted, false);
  assert.ok(c.messages.at(-1).content.includes(answer));
  assert.equal(env.store.db.prepare('SELECT count(*) AS n FROM notification_holds WHERE conversation_id=?').get(client.id).n, 0);
});
