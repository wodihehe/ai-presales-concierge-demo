/**
 * [SYNTHETIC_FIXTURE]
 * 纯合成隔离测试数据，带有明确的合成标识，仅用于自动化测试与契约验证。
 * 严禁将测试数据混入正式空知识库。
 */

export const SYNTHETIC_FIXTURES = [
  // 1. 标准有同类有报价案例 (AI Agent定制 / 工作流)
  {
    id: 'syn_proj_ecommerce_agent',
    title: '[SYNTHETIC_FIXTURE] 跨境电商平台智能导购与工单处理Agent',
    category: '工作流搭建',
    scenario: '电商全渠道客服与售后自动化，打通独立站与ERP',
    problem: '人工客服夜间响应慢、退换货工单流转耗时长',
    overview: '构建基于工作流的智能客服Agent，自动处理退换货意向，流转工单并同步ERP。',
    inputs: '客户会话消息、订单号、物流信息',
    outputs: '工单摘要、退换货建议、ERP记录',
    integrations: 'Shopify, 企业微信, ERP系统',
    deployment: '公有云SaaS部署',
    deliverables: 'Agent工作流编排配置、API对接中间件、操作手册',
    exclusions: '不包含ERP源码修改，不包含第三方大模型API费用',
    public_title: '跨境电商多平台智能客服与工单自动化Agent',
    public_summary: '面向中大型跨境电商的智能客服Agent工作流，实现意图识别、工单自动流转及ERP打通。',
    status: 'approved',
    draft_version: 2,
    features: ['多渠道客服消息接入', '退换货工单自动创建', 'ERP库存与订单查询', '夜间自动接单'],
    phases: [
      {
        id: 'phase_ecom_1',
        phase_name: '一期 (基础工单流转)',
        scope_description: '实现常见问题问答与退换货工单对接',
        relation: 'standalone',
        amount_min: 45000,
        amount_max: 55000,
        currency: 'CNY',
        raw_amount_text: '一期交付固定费用 50,000 元 (浮动区间 4.5万~5.5万)',
        cost_scope: '含税，不含模型调用费',
        source_location: '方案书第4页',
        allow_cs_quote: 1
      },
      {
        id: 'phase_ecom_2',
        phase_name: '二期 (多语言扩展)',
        scope_description: '支持英法西多语种智能切换',
        relation: 'standalone',
        amount_min: 30000,
        amount_max: 30000,
        currency: 'CNY',
        raw_amount_text: '二期增量费用 30,000 元',
        cost_scope: '不含翻译API费用',
        source_location: '方案书第5页',
        allow_cs_quote: 1 // 允许对客引用，用于验证单项目多期去重
      }
    ],
    styles: [
      {
        topic: '交付边界写法',
        desensitized_example: '本项目交付物以约定的工作流中间件为准，第三方系统API限流及网络抖动责任由对应供应商承担。',
        source_location: '方案书第7章第2节'
      }
    ]
  },

  // 2. 有同类但无价格案例 (仅方案参考)
  {
    id: 'syn_proj_noprice_case',
    title: '[SYNTHETIC_FIXTURE] 某政企智能知识检索助手',
    category: 'AI Agent定制',
    scenario: '政企内部规章制度问答与办事指南检索',
    problem: '内部规章繁杂，员工检索困难',
    overview: '基于私有知识库的精准政企问答Agent，对接内部OA。',
    inputs: '政策文件PDF、规章制度Word',
    outputs: '办事指南摘要、出处页码引用',
    integrations: '内部OA系统',
    deployment: '内网私有环境',
    deliverables: '私有知识库Agent、检索微服务',
    exclusions: '不包含政企老旧OA系统底层改造',
    public_title: '政企内网规章精准问答与办事指南知识库',
    public_summary: '针对政企多源文档的内网检索Agent，保障数据不外流。',
    status: 'approved',
    draft_version: 1,
    features: ['多格式文档切片', '政策法规语义匹配', '内网鉴权对接'],
    phases: [
      {
        id: 'phase_noprice_1',
        phase_name: '整体项目',
        scope_description: '方案有参考价值，但合同价格涉及集团统一采购，不具备对客参考性',
        relation: 'standalone',
        amount_min: null,
        amount_max: null,
        currency: 'CNY',
        raw_amount_text: '价格保密，仅方案参考',
        cost_scope: '保密',
        source_location: '结算单',
        allow_cs_quote: 0 // 无有效价格
      }
    ],
    styles: [
      {
        topic: '章节组织',
        desensitized_example: '方案划分为：需求背景 -> 架构拓扑 -> 数据流向 -> 权限与审计 -> 验收指标 五大标准章节。',
        source_location: '方案模板第1页'
      }
    ]
  },

  // 3. 非 CNY 币种案例 (美元结算，不可在 CNY 报价中直接返回)
  {
    id: 'syn_proj_usd_case',
    title: '[SYNTHETIC_FIXTURE] 海外独立站商品图AI生成工作流',
    category: '工作流搭建',
    scenario: '欧美跨境电商时尚服装产品图智能扩图与换色',
    problem: '服装模特实拍成本过高',
    overview: '搭建自动化图片生成工作流，批量生成多场景模特展示图。',
    inputs: '服装白底平铺图',
    outputs: '高保真场景模特图',
    integrations: 'ComfyUI, Webhook',
    deployment: '海外GPU云实例',
    deliverables: '工作流JSON、微调LoRA模型',
    exclusions: '不包含GPU算力租赁费用',
    public_title: '跨境电商服装场景图AI扩图自动化工作流',
    public_summary: '基于开源工作流引擎的商品图换色换背景生成系统。',
    status: 'approved',
    draft_version: 1,
    features: ['ComfyUI工作流自动化', '多场景背景替换', '模特一致性保留'],
    phases: [
      {
        id: 'phase_usd_1',
        phase_name: '一期',
        scope_description: '海外客户美元报价',
        relation: 'standalone',
        amount_min: 8000,
        amount_max: 8000,
        currency: 'USD', // 非 CNY
        raw_amount_text: '$8,000 USD',
        cost_scope: '不含GPU费用',
        source_location: 'Invoice #102',
        allow_cs_quote: 1
      }
    ],
    styles: []
  },

  // 4. 本地大模型部署案例 (专项领域，用于验证防跨类型关键词碰撞)
  {
    id: 'syn_proj_local_llm',
    title: '[SYNTHETIC_FIXTURE] 制造业企业级本地大模型私有化部署与微调',
    category: '本地大模型部署',
    scenario: '工业制造车间离线内网部署，严格物理隔离',
    problem: '数据高度涉密，禁止访问任何公网',
    overview: '在客户自备多卡服务器上部署开源大模型（如 Qwen2.5-72B），配置本地 vLLM 高并发推理。',
    inputs: '私有质检日志、操作规程',
    outputs: '离线模型推理服务API',
    integrations: '工业MES网关',
    deployment: '纯内网物理服务器集群',
    deliverables: 'vLLM推理集群、本地监控面板、运维脚本',
    exclusions: '不负责客户硬件服务器采购与机房布线',
    public_title: '制造企业纯离线本地大模型推理集群私有化部署',
    public_summary: '在物理隔离内网部署70B级开源模型并打通MES系统。',
    status: 'approved',
    draft_version: 1,
    features: ['vLLM并发优化', '纯离线内网部署', 'MES数据流对接', '多卡并行加速'],
    phases: [
      {
        id: 'phase_llm_1',
        phase_name: '部署与调优',
        scope_description: '硬件检查、模型权重配置与推理服务封装',
        relation: 'standalone',
        amount_min: 68000,
        amount_max: 68000,
        currency: 'CNY',
        raw_amount_text: '部署实施费用 68,000 元',
        cost_scope: '不含硬件服务器',
        source_location: '实施报价单',
        allow_cs_quote: 1
      }
    ],
    styles: []
  },

  // 5. 待审核草稿案例 (未审核，必须绝对隔离，不能被客服或搜索召回)
  {
    id: 'syn_proj_unapproved_draft',
    title: '[SYNTHETIC_FIXTURE] 某内部待审智能客服项目 (未审核草稿)',
    category: '工作流搭建',
    scenario: '测试草稿隔离',
    problem: '测试',
    overview: '草稿内容，未经员工审核。',
    inputs: '内部数据',
    outputs: '内部数据',
    integrations: '未知',
    deployment: '未知',
    deliverables: '未知',
    exclusions: '未知',
    public_title: '未审核标题',
    public_summary: '未审核摘要',
    status: 'pending_review', // 待审核
    draft_version: 1,
    features: ['多渠道客服消息接入', '未审核功能'],
    phases: [
      {
        id: 'phase_draft_1',
        phase_name: '一期',
        scope_description: '未审核金额',
        relation: 'standalone',
        amount_min: 12000,
        amount_max: 12000,
        currency: 'CNY',
        raw_amount_text: '12000元',
        cost_scope: '',
        source_location: '',
        allow_cs_quote: 1
      }
    ],
    styles: []
  },

  // 6. 已撤回案例 (已撤回，必须绝对隔离，不能被客服或搜索召回)
  {
    id: 'syn_proj_revoked_case',
    title: '[SYNTHETIC_FIXTURE] 某因故撤回的错误报价案例',
    category: '工作流搭建',
    scenario: '测试撤回隔离',
    problem: '测试',
    overview: '历史错误录入，已被撤回。',
    inputs: '',
    outputs: '',
    integrations: '',
    deployment: '',
    deliverables: '',
    exclusions: '',
    public_title: '已撤回标题',
    public_summary: '已撤回摘要',
    status: 'revoked', // 已撤回
    draft_version: 1,
    features: ['退换货工单自动创建'],
    phases: [
      {
        id: 'phase_revoked_1',
        phase_name: '一期',
        scope_description: '错误金额',
        relation: 'standalone',
        amount_min: 999999,
        amount_max: 999999,
        currency: 'CNY',
        raw_amount_text: '999999元',
        cost_scope: '',
        source_location: '',
        allow_cs_quote: 1
      }
    ],
    styles: []
  }
];
