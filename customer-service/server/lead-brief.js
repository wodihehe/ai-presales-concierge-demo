// Render only persisted customer facts. This formatter never calls a model or
// infers a price, an integration, a platform, or consent from free-form text.
const clean = value => typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
const key = value => clean(value).normalize('NFKC').toLowerCase().replace(/[\s。.!！?？；;，,]+$/g, '');
const unique = values => [...new Map(values.filter(Boolean).map(value => [key(value), value])).values()];
const phrases = value => clean(value).split(/[；;]/u).map(value => value.trim()).filter(Boolean);
const clauses = value => clean(value).split(/[，；;。\n]|(?<!\d),|,(?!\d)/u).map(intro).filter(Boolean);
const uncertain = value => /^(?:未提供|待沟通|待确认|待补充|不确定|不知道|还没定|还没想好|暂未确定)[。！.!]*$/u.test(clean(value));
const shortAnswer = value => /^(?:嗯|嗯嗯|是|是的|对|对的|没错|好|好的|好吧|可以|行|ok|谢谢|谢谢你|都行|都可以|都有|都能提供|都可以提供|可以提供)[。！.!]*$/iu.test(clean(value));
const useful = value => { const text = clean(value); return text && !uncertain(text) && !shortAnswer(text) ? text : ''; };
const boundary = value => /^(?:不需要|无需|不用|不做|暂不|不支持|不要|仅需|只需|只做|仅做)/u.test(value);
const intro = value => clean(value).replace(/^(?:然后|另外|还有)[，,\s]*/u, '').replace(/^(?:目的(?:主要)?是|主要目的(?:是)?)(?:能够|可以)?/u, '').trim();
const projectIntro = value => intro(value).replace(/^(?:我(?:们)?(?:想要?|希望|需要))\s*/u, '').replace(/^(?:搭建|开发|做)(?:一个|一套|个)\s*/u, '').replace(/\bai\s*agent\b/giu, 'AI Agent');

const noQuoteReasons = {
  not_configured: '知识库尚未接入',
  unavailable: '报价依据暂不可用',
  no_match: '暂无同类案例',
  no_price: '缺少可靠价格依据',
};
const feedbackLabels = { accepted: '接受参考区间（待人工确认）', too_high: '价格偏高', considering: '待考虑' };

export function leadBrief(payload) {
  const p = payload, contact = p.contact || {};
  const projectClauses = clauses(p.project);
  const firstClause = projectIntro(projectClauses[0] || '') || '待沟通项目';
  const shortProject = [...firstClause].length <= 60;
  const isGenericProject = /^(?:AI Agent|智能体|工作流|系统|工具)$/iu.test(firstClause);
  const headlineDetail = shortProject && isGenericProject && projectClauses[1] && [...projectClauses[1]].length <= 40 ? projectClauses[1] : '';
  const project = shortProject ? [firstClause, headlineDetail].filter(Boolean).join(' · ') : '客户项目（详见需求）';
  const projectDetails = shortProject ? projectClauses.slice(headlineDetail ? 2 : 1) : projectClauses;
  const inputs = useful(p.inputs), outputs = useful(p.outputs), integrations = useful(p.integrations);
  const fieldFacts = [inputs, outputs, integrations].flatMap(phrases);
  const fieldKeys = new Set(fieldFacts.map(key));
  const context = unique([useful(p.scenario), useful(p.problem)].filter(value => key(value) !== key(project)));
  const contextKeys = new Set(context.flatMap(phrases).map(key));
  const validFeatures = (Array.isArray(p.features) ? p.features : []).flatMap(phrases).map(intro).map(useful).filter(Boolean);
  const details = unique([...validFeatures, ...projectDetails]
    .flatMap(phrases).map(intro).map(useful)
    .filter(value => value && key(value) !== key(project) && key(value) !== key(headlineDetail) && !fieldKeys.has(key(value)) && !contextKeys.has(key(value))));
  const features = details.filter(value => !boundary(value));
  const constraints = unique([...details.filter(boundary), ...phrases(integrations).filter(boundary)]);
  const connections = phrases(integrations).filter(value => !boundary(value));

  // Exact phrase comparison only: a positive feature must never swallow a
  // negation, a changed quantity, a future condition, or a new scope item.
  const known = new Set([p.project, ...projectClauses, project, ...context, ...details, ...fieldFacts, p.budget, p.timeline]
    .filter(Boolean).flatMap(value => [clean(value), intro(value)]).map(key));
  const noteClauses = clauses(p.latestCustomerNote);
  // A bare restatement of generation-only adds nothing when this same message
  // already repeats the recorded no-publishing boundary and generation goal.
  // Keep it otherwise: it could be a new scope change.
  const repeatsGenerationScope = noteClauses.some(value => /^(?:不需要|无需|不用)自动发布$/u.test(value) && known.has(key(value))) &&
    [project, ...details].some(value => /(?:生成|制作|产出).+(?:图|文案|内容|视频)/u.test(value));
  const note = unique(noteClauses.filter(value => useful(value) && !known.has(key(value)) &&
    !(repeatsGenerationScope && /^(?:自动)?生成(?:就可以|即可)(?:了)?$/u.test(value)))).join('；');
  const unresolvedNote = note && !known.has(key(clean(p.latestCustomerNote))) ? note : '';

  const stage = !p.quote ? '待人工评估' : ({ accepted: '接受参考价', too_high: '价格待沟通', considering: '客户考虑中' }[p.feedback] || '待客户反馈');
  const contacts = [contact.phone && `手机 ${clean(contact.phone)}`, contact.wechat && `微信 ${clean(contact.wechat)}`, contact.email && `邮箱 ${clean(contact.email)}`].filter(Boolean);
  const identity = [clean(contact.name), clean(contact.company)].filter(Boolean).join(' · ');
  const opening = [
    `【网站咨询 · ${stage}】`,
    `项目：${project}`,
    `联系：${contacts.join('；') || '待补充'}${contact.consent ? '（已同意跟进）' : ''}`,
    identity && `客户：${identity}`,
  ].filter(Boolean);

  const requirements = [
    `需求（${p.confirmed ? '客户已确认' : '待客户确认'}）`,
    context.length && `• 背景：${context.join('；')}`,
    ...features.map(value => `• ${value}`),
    inputs && `• 输入材料：${inputs}`,
    outputs && `• 输出：${outputs}`,
    constraints.length && `• 范围：${constraints.join('；')}`,
    connections.length && `• 对接：${connections.join('；')}`,
  ].filter(Boolean);

  const commercial = [];
  if (p.quote) {
    commercial.push(`参考报价：${p.quote.min}–${p.quote.max} ${p.quote.currency}，最终待人工确认`);
    commercial.push(`客户反馈：${feedbackLabels[p.feedback] || '尚未反馈'}`);
  } else {
    commercial.push(`报价：尚未报价，需人工评估${noQuoteReasons[p.knowledgeStatus] ? `（${noQuoteReasons[p.knowledgeStatus]}）` : ''}`);
    if (feedbackLabels[p.feedback]) commercial.push(`此前反馈：${feedbackLabels[p.feedback]}；当前无有效报价，需复核`);
  }
  const budget = useful(p.budget), timeline = useful(p.timeline);
  if (budget || timeline) commercial.push([budget && `预算：${budget}`, timeline && `期望时间：${timeline}`].filter(Boolean).join('；'));

  const pending = [];
  if (!validFeatures.length && !projectDetails.some(useful) && !headlineDetail) pending.push('具体功能');
  if (!inputs) pending.push('输入材料清单');
  if (!outputs) pending.push('交付形式');
  if (!integrations) pending.push('系统对接需求');
  if (!timeline) pending.push('期望交付时间');
  const followup = [unresolvedNote && `补充（待核实）：${unresolvedNote}`, pending.length && `待确认：${pending.join('、')}`];
  const reason = clean(p.reason);
  const alreadyExplained = reason === '客户愿意接受项目跟进' || (p.confirmed && reason === '需求已确认，待顾问跟进') || (p.knowledgeStatus === 'no_match' && reason === '新类型项目，暂无同类案例');
  if (reason && !alreadyExplained) followup.push(`跟进原因：${reason}`);
  return [opening.join('\n'), requirements.join('\n'), commercial.join('\n'), followup.filter(Boolean).join('\n')].filter(Boolean).join('\n\n');
}

// Keep normal lines together. Only a single oversized line needs a Unicode
// character split. Reserve ample room for the multipart prefix below 2048 B.
export function briefParts(payload) {
  const text = leadBrief(payload), parts = [];
  let part = '';
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) || []) {
    if (Buffer.byteLength(part + line) <= 1800) { part += line; continue; }
    if (part) { parts.push(part); part = ''; }
    for (const ch of line) {
      if (Buffer.byteLength(part + ch) > 1800) { parts.push(part); part = ''; }
      part += ch;
    }
  }
  if (part) parts.push(part);
  return parts.map((part, index) => parts.length > 1 ? `【项目通知 ${index + 1}/${parts.length}】\n${part}` : part);
}
