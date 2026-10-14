import test from 'node:test';
import assert from 'node:assert/strict';
import { leadBrief } from '../server/lead-brief.js';
import { messageParts } from '../server/notifications.js';

// Synthetic project/contact data only; never sends a notification.
const base = () => ({
  project: '合成测试：商品素材助手', scenario: '运营团队处理商品资料', problem: '手工整理耗时',
  features: ['生成商品图片', '生成商品介绍文案'], inputs: '商品照片及参数表', outputs: '主图和详情长图',
  integrations: '暂不对接', budget: '', timeline: '', confirmed: false,
  quote: null, feedback: 'not_quoted', knowledgeStatus: 'not_configured',
  contact: { email: 'synthetic-lead@example.test', consent: true }, reason: '客户愿意接受项目跟进', latestCustomerNote: '',
});

test('ecommerce brief highlights project/contact, deduplicates scope, and turns unclear input into a follow-up item', () => {
  const text = leadBrief({ ...base(),
    project: '搭建一个AI Agent，目的主要是能够生成商品主图与详情图，然后商品文案也能生成',
    scenario: '', problem: '用于合成测试电商平台',
    features: ['生成商品主图与详情图', '商品文案也能生成', '图片风格可按要求调整', '不需要自动发布', '长图'],
    inputs: '都能提供', outputs: '长图', integrations: '不需要自动发布',
    latestCustomerNote: '不需要自动发布，自动生成就可以，长图，是的',
  });
  assert.equal(text.split('\n')[0], '【网站咨询 · 待人工评估】');
  assert.match(text, /项目：AI Agent · 生成商品主图与详情图/);
  assert.ok(text.indexOf('synthetic-lead@example.test') < text.indexOf('需求（'));
  for (const fact of ['生成商品主图与详情图', '商品文案也能生成', '图片风格可按要求调整', '不需要自动发布', '长图', '尚未报价']) {
    assert.equal(text.split(fact).length - 1, 1, `fact should appear once: ${fact}`);
  }
  assert.match(text, /待确认：输入材料清单、期望交付时间/);
  assert.doesNotMatch(text, /待确认：.*预算/);
  assert.match(text, /需求（待客户确认）/);
  assert.doesNotMatch(text, /都能提供|是的|最新补充|客户反馈|补充（待核实）|无需对接|系统无需对接/);
  assert.ok(text.length < 400);
});

for (const [feedback, expected] of Object.entries({ accepted: '接受参考区间（待人工确认）', too_high: '价格偏高', considering: '待考虑', not_quoted: '尚未反馈' })) {
  test(`quoted lead preserves actual customer feedback: ${feedback}`, () => {
    const text = leadBrief({ ...base(), confirmed: true, quote: { min: 12000, max: 18000, currency: 'CNY' }, feedback });
    assert.match(text, /参考报价：12000–18000 CNY，最终待人工确认/);
    assert.ok(text.includes(`客户反馈：${expected}`));
    assert.match(text, /需求（客户已确认）/);
    assert.doesNotMatch(text, /尚未报价|已成交|最终成交/);
  });
}

for (const [knowledgeStatus, reason] of Object.entries({ not_configured: '知识库尚未接入', unavailable: '报价依据暂不可用', no_match: '暂无同类案例', no_price: '缺少可靠价格依据' })) {
  test(`unquoted lead gives accurate reason: ${knowledgeStatus}`, () => {
    const text = leadBrief({ ...base(), knowledgeStatus });
    assert.ok(text.includes(`报价：尚未报价，需人工评估（${reason}）`));
    assert.equal(text.split('尚未报价').length - 1, 1);
    assert.doesNotMatch(text, /0元|0–0|客户反馈/);
    if (knowledgeStatus !== 'no_match') assert.doesNotMatch(text, /暂无同类案例/);
  });
}

test('exact deduplication never swallows negation, changed quantities or future conditions', () => {
  const text = leadBrief({ ...base(), features: ['自动发布', '不需要自动发布', '单张主图', '主图加长图'], integrations: '暂不对接', latestCustomerNote: '以后对接ERP，新增批量审核，每次增加到20张' });
  for (const fact of ['自动发布', '不需要自动发布', '单张主图', '主图加长图', '暂不对接', '以后对接ERP', '新增批量审核', '每次增加到20张']) assert.ok(text.includes(fact));
  assert.match(text, /补充（待核实）：以后对接ERP；新增批量审核；每次增加到20张/);
});

test('new generation-only restriction is preserved when it is not an already-known boundary', () => {
  const text = leadBrief({ ...base(), latestCustomerNote: '自动生成就可以' });
  assert.match(text, /补充（待核实）：自动生成就可以/);
});

test('thousands separators in project counts and supplementary budgets remain intact', () => {
  const text = leadBrief({ ...base(), project: '每周处理1,000个商品', latestCustomerNote: '预算12,000元，月处理量10,000项' });
  assert.match(text, /项目：每周处理1,000个商品/);
  assert.match(text, /补充（待核实）：预算12,000元；月处理量10,000项/);
});

test('features made entirely of ambiguous replies are still listed as missing', () => {
  const text = leadBrief({ ...base(), features: ['是的', '都可以'] });
  assert.match(text, /待确认：具体功能、期望交付时间/);
  assert.doesNotMatch(text, /• 是的|• 都可以/);
});

test('pure acknowledgements and empty fields do not fill the brief with raw answers', () => {
  const text = leadBrief({ ...base(), inputs: '是的', budget: '不确定', timeline: '还没定', latestCustomerNote: '好的，是的，谢谢' });
  assert.doesNotMatch(text, /是的|谢谢|补充（待核实）|未提供|不确定|还没定/);
  assert.match(text, /待确认：输入材料清单、期望交付时间/);
  assert.doesNotMatch(text, /待确认：.*预算/);
  assert.match(text, /范围：暂不对接/);
});

test('optional identities, all contact methods, real preferences, and explicit handoff reason remain', () => {
  const text = leadBrief({ ...base(), budget: '预算上限5000元', timeline: '期望10月底', reason: '客户主动请求人工', contact: { phone: '000-000-0000', wechat: 'synthetic_wechat', email: 'synthetic@example.test', name: '合成测试联系人', company: '合成测试公司', consent: true } });
  for (const value of ['000-000-0000', 'synthetic_wechat', 'synthetic@example.test', '合成测试联系人', '合成测试公司', '预算上限5000元', '期望10月底', '客户主动请求人工', '已同意跟进']) assert.ok(text.includes(value));
  assert.doesNotMatch(text, /待确认：.*预算/);
});

test('scope change cannot turn old accepted feedback into a currently accepted quote', () => {
  const text = leadBrief({ ...base(), quote: null, feedback: 'accepted', knowledgeStatus: 'unavailable' });
  assert.ok(text.startsWith('【网站咨询 · 待人工评估】'));
  assert.match(text, /此前反馈：接受参考区间（待人工确认）；当前无有效报价，需复核/);
});

test('long and multilingual facts survive UTF-8 splitting without truncation and contact stays in first part', () => {
  const payload = { ...base(), project: '长项目说明😀'.repeat(200), features: Array.from({ length: 12 }, (_, i) => `功能${i}：${'测试多语言😀商品'.repeat(90)}`), quote: { min: 12000, max: 18000, currency: 'CNY' } };
  const parts = messageParts(payload);
  assert.ok(parts.length > 2);
  assert.ok(parts.every(part => Buffer.byteLength(part) < 2048 && !part.includes('\uFFFD')));
  assert.ok(parts[0].includes(payload.contact.email));
  const reconstructed = parts.map(part => part.replace(/^【项目通知 \d+\/\d+】\n/u, '')).join('');
  assert.equal(reconstructed, leadBrief(payload));
  assert.ok(reconstructed.includes(payload.project));
  for (const fact of payload.features) assert.ok(reconstructed.includes(fact));
  assert.ok(reconstructed.includes('12000–18000 CNY'));
});
