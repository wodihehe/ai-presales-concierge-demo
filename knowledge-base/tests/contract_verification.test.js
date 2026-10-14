import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDatabase } from './helpers/testDb.js';
import { createApp } from '../server/index.js';

// Parent customer service validators (replicated from intelligence.js for verification)
function validCase(value) {
  const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  return isRecord(value) && typeof value.id === 'string' && value.id.trim().length > 0 && value.id.length <= 128
    && ['category', 'title', 'summary'].every(field => typeof value[field] === 'string' && value[field].length <= 20000)
    && Array.isArray(value.features) && value.features.length <= 100 && value.features.every(feature => typeof feature === 'string' && feature.length <= 2000)
    && typeof value.approved === 'boolean' && typeof value.public === 'boolean' && typeof value.match === 'boolean';
}

function validAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isSafeInteger(Math.round(value * 100))
    && Math.abs(value * 100 - Math.round(value * 100)) < 0.000_001;
}

function validPrice(price) {
  const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  return isRecord(price) && price.currency === 'CNY' && validAmount(price.min) && validAmount(price.max) && price.min <= price.max;
}

function simulateParentRetrieveQuote(response) {
  const empty = status => ({ status, quote: null, sources: [] });
  if (!response || typeof response !== 'object' || !Array.isArray(response.cases) || response.cases.length > 1000) {
    return empty('unavailable');
  }

  const cases = response.cases.filter(validCase);
  if (cases.length !== response.cases.length) {
    return empty('unavailable');
  }

  const matched = cases.filter(item => item.match === true);
  if (matched.length === 0) return empty('no_match');

  const usable = matched.filter(item => item.approved === true && item.public === true);
  const priced = usable.filter(item => validPrice(item.price));

  if (priced.length === 0) {
    return { status: 'no_price', quote: null, sources: [...new Set(usable.map(item => item.id))] };
  }

  return {
    status: 'quoted',
    quote: {
      min: Math.min(...priced.map(item => item.price.min)),
      max: Math.max(...priced.map(item => item.price.max)),
      currency: 'CNY'
    },
    sources: [...new Set(priced.map(item => item.id))]
  };
}

test('客服契约测试套件 (INTEGRATION_CONTRACT.md 8类场景隔离验证)', async (t) => {
  // Setup memory test db
  setupTestDatabase(':memory:');
  const app = createApp();

  let server;
  let testPort = 3299;
  let baseUrl;

  await new Promise(resolve => {
    server = app.listen(testPort, () => {
      baseUrl = `http://127.0.0.1:${testPort}`;
      resolve();
    });
  });

  t.after(() => {
    server.close();
  });

  const validToken = 'test_secret_key_123';

  await t.test('1. 有同类且有价格：返回有效CNY区间与真正布尔值，父客服得出 quoted', async () => {
    const res = await fetch(`${baseUrl}/api/integrations/customer-service/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        query: '跨境电商多平台智能客服工作流，支持退换货工单流转与ERP打通',
        profile: {
          project: '电商智能客服Agent',
          scenario: '跨境电商客服与工单自动化',
          features: ['退换货工单自动创建', 'ERP库存与订单查询']
        }
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.cases));
    assert.ok(data.cases.length > 0);

    // Verify boolean types are genuine booleans
    for (const c of data.cases) {
      assert.equal(typeof c.approved, 'boolean');
      assert.equal(typeof c.public, 'boolean');
      assert.equal(typeof c.match, 'boolean');
    }

    // Verify parent customer service consumption logic
    const csResult = simulateParentRetrieveQuote(data);
    assert.equal(csResult.status, 'quoted');
    assert.equal(csResult.quote.min, 45000);
    assert.equal(csResult.quote.max, 55000);
    assert.equal(csResult.quote.currency, 'CNY');
  });

  await t.test('2. 有同类但无价格依据：返回 match:true 且 price:null，父客服得出 no_price', async () => {
    const res = await fetch(`${baseUrl}/api/integrations/customer-service/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        query: '政企内部规章制度问答与办事指南检索知识库',
        profile: {
          scenario: '政企内部规章制度问答',
          features: ['多格式文档切片', '政策法规语义匹配']
        }
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    const matched = data.cases.filter(c => c.match === true);
    assert.ok(matched.length > 0);
    assert.equal(matched[0].price, null);

    const csResult = simulateParentRetrieveQuote(data);
    assert.equal(csResult.status, 'no_price');
    assert.ok(csResult.sources.length > 0);
  });

  await t.test('3. 确无同类案例：返回 cases 为空数组，父客服得出 no_match', async () => {
    const res = await fetch(`${baseUrl}/api/integrations/customer-service/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        query: '航空航天卫星遥感轨迹动力学实时仿真计算引擎',
        profile: {
          scenario: '深空探测航天动力学',
          features: ['轨道力学微元计算', '卫星姿态动力学控制']
        }
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    const csResult = simulateParentRetrieveQuote(data);
    assert.equal(csResult.status, 'no_match');
  });

  await t.test('4. 严格隔离：待审核 (draft/pending) 与 已撤回 (revoked) 案例绝不泄露', async () => {
    const res = await fetch(`${baseUrl}/api/integrations/customer-service/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        query: '测试草稿隔离 与 错误报价案例',
        profile: {
          project: '测试草稿隔离'
        }
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    // Verify no unapproved or revoked project ID is returned
    const ids = data.cases.map(c => c.id);
    assert.ok(!ids.some(id => id.includes('unapproved_draft')));
    assert.ok(!ids.some(id => id.includes('revoked_case')));
  });

  await t.test('5. 单项目多期去重与阶段不相加：一个项目的多个阶段不虚增项目样本数', async () => {
    // 5.1 Baseline phase query
    const res1 = await fetch(`${baseUrl}/api/integrations/customer-service/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        query: '跨境电商退换货售后工单自动化流转，对接Shopify与ERP系统',
        profile: {
          scenario: '跨境电商客服与工单自动化',
          features: ['退换货工单自动创建', 'ERP库存与订单查询']
        }
      })
    });

    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    const ecomCases1 = data1.cases.filter(c => c.id.startsWith('syn_proj_ecommerce_agent'));
    assert.equal(ecomCases1.length, 1, '单个项目即使拥有多个获准对客引用的阶段，在报价检索中也只返回单一可比阶段，严禁虚增样本数');
    assert.ok(ecomCases1[0].id.includes('phase_ecom_1'));
    assert.equal(ecomCases1[0].price.min, 45000);
    assert.equal(ecomCases1[0].price.max, 55000);

    // 5.2 Specific phase 2 query
    const res2 = await fetch(`${baseUrl}/api/integrations/customer-service/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        query: '跨境电商客服系统二期多语言智能扩展',
        profile: {
          scenario: '跨境电商客服二期'
        }
      })
    });

    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    const ecomCases2 = data2.cases.filter(c => c.id.startsWith('syn_proj_ecommerce_agent'));
    assert.equal(ecomCases2.length, 1);
    assert.ok(ecomCases2[0].id.includes('phase_ecom_2'));
    assert.equal(ecomCases2[0].price.min, 30000);
    assert.equal(ecomCases2[0].price.max, 30000);

    // 5.3 A broad query cannot treat every phase as comparable numeric evidence.
    const ctxRes = await fetch(`${baseUrl}/api/integrations/customer-service/context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        query: '跨境电商多平台智能客服'
      })
    });
    assert.equal(ctxRes.status, 200);
    const ctxData = await ctxRes.json();
    const ecomEvidence = ctxData.priceEvidence.filter(p => p.caseId === 'syn_proj_ecommerce_agent');
    assert.equal(ecomEvidence.length, 0, '未说明阶段范围时不把所有阶段价格返回作当前需求依据');
  });

  await t.test('6. 非CNY币种隔离：美元USD价格原样保留，不虚假换算为CNY价格', async () => {
    const res = await fetch(`${baseUrl}/api/integrations/customer-service/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        query: '海外独立站服装模特产品图换色换背景工作流 ComfyUI'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    const usdCase = data.cases.find(c => c.id.includes('syn_proj_usd_case'));
    if (usdCase) {
      assert.equal(usdCase.price, null, '非CNY币种在客服CNY报价查询中必须为 null');
    }
  });

  await t.test('7. 接口鉴权安全：无密钥或错误密钥返回 401/403', async () => {
    // Missing Bearer
    const res1 = await fetch(`${baseUrl}/api/integrations/customer-service/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' })
    });
    assert.equal(res1.status, 401);

    // Wrong Bearer
    const res2 = await fetch(`${baseUrl}/api/integrations/customer-service/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong_token_999'
      },
      body: JSON.stringify({ query: 'test' })
    });
    assert.equal(res2.status, 403);
  });

  await t.test('8. 方案与风格上下文接口 (POST /customer-service/context)', async () => {
    const res = await fetch(`${baseUrl}/api/integrations/customer-service/context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({
        query: '跨境电商多平台智能客服工作流'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.ok(Array.isArray(data.styleReferences));
    assert.ok(Array.isArray(data.priceEvidence));
    assert.ok(data.styleReferences.length > 0);
    assert.ok(data.styleReferences[0].topic.includes('交付边界'));
  });
});
