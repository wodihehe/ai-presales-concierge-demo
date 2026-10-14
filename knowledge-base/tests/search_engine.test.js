import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDatabase } from './helpers/testDb.js';
import { SearchService } from '../server/services/searchService.js';
import { getDatabase } from '../server/db/index.js';

test('两阶段检索与范围适配引擎测试 (P1 专项)', async (t) => {
  setupTestDatabase(':memory:');

  await t.test('1. 跨类型关键词碰撞防御：工作流需求与本地私有化部署案例不误标为 match:true', () => {
    // Query asks specifically for workflow automation, but mentions "电商"
    const result = SearchService.searchFormalCases({
      query: '电商平台自动化图片生成与场景扩图工作流搭建',
      profile: {
        scenario: '工作流自动化'
      }
    });

    const localLlmCase = result.cases.find(c => c.id.includes('syn_proj_local_llm'));
    if (localLlmCase) {
      assert.equal(localLlmCase.match, false, '本地私有化部署项目在工作流查询中不能标为 match:true');
    }
  });

  await t.test('2. 适用范围高度相近时，正确标记 match:true 并提取价格', () => {
    const result = SearchService.searchFormalCases({
      query: '工业生产制造企业车间离线内网部署，vLLM推理集群',
      profile: {
        scenario: '车间离线内网部署',
        features: ['vLLM并发优化', '纯离线内网部署']
      }
    });

    const llmCase = result.cases.find(c => c.id.includes('syn_proj_local_llm'));
    assert.ok(llmCase, '应召回本地大模型案例');
    assert.equal(llmCase.match, true, '范围与交付边界一致时必须为 match:true');
    assert.equal(llmCase.price.min, 68000);
    assert.equal(llmCase.price.max, 68000);
  });

  await t.test('3. 风格依据与出处定位正确提取', () => {
    const ctx = SearchService.getStyleAndQuoteContext({
      query: '政企内部规章制度问答'
    });

    assert.equal(ctx.status, 'ok');
    const style = ctx.styleReferences.find(s => s.topic.includes('章节'));
    assert.ok(style);
    assert.ok(style.example.includes('五大标准章节'));
  });
  await t.test('4. 对接与规模不具备依据时不套用报价',()=>{
    for(const profile of [{integrations:'Salesforce CRM定制接口'},{project:'10000用户同时使用'}]){
      const result=SearchService.searchFormalCases({query:'一期跨境电商ERP退换货工单工作流',profile});
      const c=result.cases.find(c=>c.id.startsWith('syn_proj_ecommerce_agent'));assert.ok(c);assert.equal(c.price,null);
    }
  });
  await t.test('5. 云端要求不沿用纯内网实施价；不存在的阶段无价',()=>{
    let result=SearchService.searchFormalCases({query:'制造企业vLLM并发优化云端推理服务',profile:{features:['vLLM并发优化']}});
    assert.equal(result.cases.find(c=>c.id.startsWith('syn_proj_local_llm')).price,null);
    result=SearchService.searchFormalCases({query:'三期跨境电商ERP退换货工单工作流'});
    assert.equal(result.cases.find(c=>c.id.startsWith('syn_proj_ecommerce_agent')).price,null);
  });
  await t.test('6. 请求非法功能列表不能进入上下文处理',()=>{
    assert.throws(()=>SearchService.getStyleAndQuoteContext({query:'工单',profile:{features:'ERP'}}),/格式/);
  });
  await t.test('7. 已记录的三期报价可选中，不硬编码只支持二期',()=>{
    const db=getDatabase();
    const phase=db.prepare("SELECT * FROM project_phases WHERE project_id='syn_proj_ecommerce_agent' ORDER BY order_index DESC LIMIT 1").get();
    assert.ok(phase);
    try {
      db.prepare("UPDATE project_phases SET phase_name='三期', relation='standalone' WHERE id=?").run(phase.id);
      const result=SearchService.searchFormalCases({query:'三期跨境电商ERP退换货工单工作流'});
      const item=result.cases.find(c=>c.id.startsWith('syn_proj_ecommerce_agent'));
      assert.equal(item.id,`syn_proj_ecommerce_agent#${phase.id}`);
      assert.equal(item.price.min,phase.amount_min);
    } finally {
      db.prepare('UPDATE project_phases SET phase_name=?, relation=? WHERE id=?').run(phase.phase_name,phase.relation,phase.id);
    }
  });

  await t.test('8. 标题强信号与受控同义词可识别相似案例，但未知阶段不报价',()=>{
    const db=getDatabase();
    const id='syn_proj_it_ops_title';
    db.prepare(`INSERT INTO projects (id,title,category,scenario,problem,overview,inputs,outputs,integrations,deployment,deliverables,exclusions,creator_id,status,draft_version,public_title,public_summary,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`).run(
      id,
      'IT运维多源告警收敛、根因分析与工单派发工作流',
      '工作流搭建',
      'IT运维',
      '多套监控告警需要统一处理',
      '告警收敛与根因研判工作流',
      'Prometheus；cmdb',
      '审批工单流程',
      'Prometheus；钉钉；cmdb',
      '运维专有VPC',
      '告警收敛、根因分析和工单闭环',
      '不执行危险生产命令',
      'usr_test',
      'approved',
      1,
      'IT运维多源告警收敛、根因分析与工单派发工作流',
      '面向IT运维团队的告警收敛、根因分析与工单派发工作流'
    );
    const feat=db.prepare('INSERT INTO project_features (id,project_id,feature_text,is_public,order_index) VALUES (?,?,?,1,?)');
    ['告警数据接入与收敛','大模型辅助根因推断','自动创建工单','审批流程闭环'].forEach((v,i)=>feat.run(`${id}_f${i}`,id,v,i));
    const phase=db.prepare(`INSERT INTO project_phases (id,project_id,phase_name,scope_description,relation,amount_min,amount_max,currency,raw_amount_text,cost_scope,source_location,allow_cs_quote,order_index)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    phase.run(`${id}_p1`,id,'一期：告警数据接入与滑动窗口收敛','统一告警格式并完成时间窗聚类','unknown',20000,28000,'CNY','一期报价 20000-28000 元','不含第三方费用','合成夹具',1,0);
    phase.run(`${id}_p2`,id,'二期：根因分析Agent与工单闭环派发','根因分析与工单闭环派发','unknown',20000,30000,'CNY','二期报价 20000-30000 元','不含第三方费用','合成夹具',1,1);
    const profile={
      project:'IT运维多源告警收敛、根因分析与工单派发工作流',
      scenario:'IT运维',
      features:['多源告警收敛','根因分析','工单派发','云端大模型','审批工单流程'],
      inputs:'Prometheus；cmdb',
      outputs:'审批工单流程',
      integrations:'Prometheus；钉钉；cmdb'
    };
    try {
      let result=SearchService.searchFormalCases({query:Object.values(profile).flat().join('\\n'),profile});
      let item=result.cases.find(c=>c.id.startsWith(id));
      assert.ok(item);
      assert.equal(item.match,true);
      assert.equal(item.price,null,'未点名阶段且关系未知时不能自动报价或相加');
      result=SearchService.searchFormalCases({query:'一期 '+profile.project,profile:{...profile,features:[...profile.features,'一期']}});
      item=result.cases.find(c=>c.id.startsWith(id));
      assert.equal(item.match,true);
      assert.equal(item.price,null,'明确一期也不能替审核人推断未知阶段价格关系');
      db.prepare('UPDATE project_phases SET relation=? WHERE id=?').run('standalone',`${id}_p1`);
      result=SearchService.searchFormalCases({query:'一期 '+profile.project,profile:{...profile,features:[...profile.features,'一期']}});
      item=result.cases.find(c=>c.id.startsWith(id));
      assert.deepEqual(item.price,{min:20000,max:28000,currency:'CNY'});
    } finally {
      db.prepare('DELETE FROM project_phases WHERE project_id=?').run(id);
      db.prepare('DELETE FROM project_features WHERE project_id=?').run(id);
      db.prepare('DELETE FROM projects WHERE id=?').run(id);
    }
  });
});
