import { getDatabase } from '../db/index.js';
import { validPhasePrice } from './draftStore.js';

// Controlled business-language aliases used for matching only. They do not
// make different platforms or deployment modes interchangeable.
const CONCEPT_ALIASES = [
  { canonical: '告警收敛', variants: ['告警收敛', '多源告警收敛', '告警聚合', '告警降噪', '告警风暴'] },
  { canonical: '根因分析', variants: ['根因分析', '根因推断', '根因定位', '故障根因', '根因研判'] },
  { canonical: '工单派发', variants: ['工单派发', '工单创建', '创建工单', '工单流转', '工单闭环', '审批工单流程', '工单审批流程'] },
  { canonical: '大模型', variants: ['大模型', '云端大模型', '大模型辅助', '模型推理'] },
  { canonical: '监控告警', variants: ['监控告警', '告警数据', '告警数据接入', '告警接入'] }
];

function semanticText(value) {
  const raw = String(value || '').toLowerCase();
  const concepts = CONCEPT_ALIASES
    .filter(group => group.variants.some(variant => raw.includes(variant.toLowerCase())))
    .map(group => group.canonical);
  return concepts.length ? `${raw} ${concepts.join(' ')}` : raw;
}

function compactText(value) {
  return semanticText(value).replace(/[\p{P}\p{S}\s]+/gu, '');
}

function hasStrongTitleSignal(project, profile, queryText) {
  const query = compactText([profile?.project, queryText].filter(Boolean).join(' '));
  if (!query) return false;
  return [project.public_title, project.title].filter(Boolean).some(title => {
    const candidate = compactText(title);
    if (candidate.length >= 8 && query.includes(candidate)) return true;
    const titleTokens = extractTokens(semanticText(title)).filter(token => token.length >= 2);
    const hits = titleTokens.filter(token => query.includes(token));
    return titleTokens.length >= 3 && hits.length / titleTokens.length >= 0.65;
  });
}

/**
 * Extract meaningful Chinese & alphanumeric search tokens using clauses and 2-4 n-grams
 */
export function extractTokens(text) {
  const tokens = new Set();
  const raw = String(text || '').trim();
  if (!raw) return [];

  const clauses = raw.split(/[\p{P}\p{S}\s]+/gu).filter(Boolean);
  for (const clause of clauses) {
    if (clause.length >= 2 && clause.length <= 10) {
      tokens.add(clause.toLowerCase());
    }
    // 2-gram to 4-gram sliding windows
    for (let len = 2; len <= Math.min(4, clause.length); len++) {
      for (let i = 0; i <= clause.length - len; i++) {
        const chunk = clause.slice(i, i + len).toLowerCase();
        if (!/^(?:的是|与和|以及|还有|能够|可以|这个|那个|我们|他们|你们|一个|要求|希望)$/u.test(chunk)) {
          tokens.add(chunk);
        }
      }
    }
  }
  return [...tokens];
}

export class SearchService {
  /**
   * Search approved formal cases and evaluate scope compatibility & price evidence
   */
  static searchFormalCases({ query = '', profile = {} } = {}) {
    if(typeof query !== 'string' || query.length > 20000 || !profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('查询格式错误');
    for(const field of ['project','scenario','problem','inputs','outputs','integrations','deployment']) if(profile[field]!==undefined && (typeof profile[field]!=='string'||profile[field].length>20000)) throw new Error('查询字段格式错误');
    if(profile.features!==undefined && (!Array.isArray(profile.features)||profile.features.length>100||profile.features.some(f=>typeof f!=='string'||f.length>2000))) throw new Error('功能查询格式错误');
    const db = getDatabase();

    // Collect query terms and clean tokens
    const queryParts = [
      query,
      profile.project,
      profile.scenario,
      profile.problem,
      ...(Array.isArray(profile.features) ? profile.features : []),
      profile.inputs,
      profile.outputs,
      profile.integrations,
      profile.deployment
    ].filter(Boolean).map(s => String(s).trim());

    const fullText = queryParts.join(' ');
    if (!fullText.trim()) {
      return { cases: [], stats: { totalCandidates: 0, matchedProjects: 0 } };
    }

    const tokens = extractTokens(fullText);

    // 1. Candidate recall from approved projects only
    // Strictly isolate: status = 'approved' AND deleted_at IS NULL
    const allApproved = db.prepare(`
      SELECT p.*,
             (SELECT json_group_array(feature_text) FROM project_features WHERE project_id = p.id AND is_public = 1) as features_json
      FROM projects p
      WHERE p.status = 'approved' AND p.deleted_at IS NULL
    `).all();

    if (allApproved.length === 0) {
      return { cases: [], stats: { totalCandidates: 0, matchedProjects: 0 } };
    }

    // Score and evaluate candidates
    const candidateResults = [];
    const matchedProjectIds = new Set();

    for (const project of allApproved) {
      const features = JSON.parse(project.features_json || '[]');
      const phases = db.prepare(`
        SELECT * FROM project_phases 
        WHERE project_id = ? 
        ORDER BY order_index ASC
      `).all(project.id);
      const styles = db.prepare(`
        SELECT * FROM style_references 
        WHERE project_id = ?
      `).all(project.id);

      const evaluation = evaluateProjectMatch({
        project,
        features,
        phases,
        queryText: fullText,
        profile,
        tokens
      });

      if (evaluation.isRelevant) {
        candidateResults.push({
          project,
          features,
          phases,
          styles,
          evaluation
        });
        if (evaluation.isMatch) {
          matchedProjectIds.add(project.id);
        }
      }
    }

    // Sort by match score descending
    candidateResults.sort((a, b) => b.evaluation.score - a.evaluation.score);

    // Format output cases
    // Contract requirement: A single response case represents one clear comparable scope.
    // Each matched project produces one representative comparable phase case to prevent sample inflation and min/max envelope contamination.
    const formattedCases = [];

    for (const item of candidateResults) {
      const { project, features, phases, evaluation } = item;

      // Filter phases: consider phases configured with allow_cs_quote = 1
      const quotePhases = phases.filter(p => p.allow_cs_quote === 1);

      if (quotePhases.length === 0) {
        // Case with no approved quote evidence (or purely for proposal reference)
        formattedCases.push({
          id: String(project.id),
          category: String(project.category || '未分类'),
          title: String(project.public_title || ''),
          summary: String(project.public_summary || ''),
          features: features.map(String).slice(0, 100),
          approved: true, // Native boolean
          public: true,   // Native boolean
          match: Boolean(evaluation.isMatch), // Native boolean
          price: null,
          matchReason: evaluation.reason
        });
      } else {
        // Select the most appropriate single comparable phase for this project
        // (default to baseline/first phase, or match specific phase if mentioned in query)
        const selectedPhase = quotePhases.find(p => phaseComparable(p, phases, fullText, profile)) || quotePhases[0];

        let priceObj = null;
        if (evaluation.isMatch && priceBoundaryComparable(project, features, fullText, profile) && phaseComparable(selectedPhase, phases, fullText, profile) && selectedPhase.currency === 'CNY' && validPhasePrice(selectedPhase)) {
          priceObj = {
            min: selectedPhase.amount_min,
            max: selectedPhase.amount_max,
            currency: 'CNY'
          };
        }

        formattedCases.push({
          id: `${project.id}#${selectedPhase.id}`,
          category: String(project.category || '未分类'),
          title: String(project.public_title || '') + (quotePhases.length > 1 ? ` (${selectedPhase.phase_name})` : ''),
          summary: String(project.public_summary || ''),
          features: features.map(String).slice(0, 100),
          approved: true,
          public: true,
          match: Boolean(evaluation.isMatch),
          price: priceObj,
          matchReason: evaluation.reason
        });
      }
    }

    return {
      cases: formattedCases.slice(0, 100),
      rawCandidates: candidateResults,
      stats: {
        totalCandidates: candidateResults.length,
        matchedProjects: matchedProjectIds.size
      }
    };
  }

  /**
   * Produce rich Proposal & Style context for integration endpoint
   */
  static getStyleAndQuoteContext({ query = '', profile = {} } = {}) {
    const searchRes = SearchService.searchFormalCases({ query, profile });
    const matchedCases = searchRes.cases.filter(c => c.match === true);

    if (matchedCases.length === 0) {
      return {
        status: 'no_match',
        cases: [],
        styleReferences: [],
        priceEvidence: [],
        missingInformation: ['未找到与当前业务需求和交付范围直接可比的已审核公司案例']
      };
    }

    // Extract style references from matched candidates
    const styleReferences = [];
    const priceEvidence = [];
    const seenStyles = new Set();
    const seenPrices = new Set();

    for (const item of searchRes.rawCandidates) {
      if (!item.evaluation.isMatch || !matchedCases.some(c=>c.id===item.project.id || c.id.startsWith(item.project.id+'#'))) continue;
      const { project, phases, styles } = item;

      // Styles
      for (const s of styles) {
        if (!seenStyles.has(s.desensitized_example)) {
          seenStyles.add(s.desensitized_example);
          styleReferences.push({
            caseId: project.id,
            topic: s.topic,
            example: s.desensitized_example,
            sourceFileId: s.source_file_id || null
          });
        }
      }

      // Prices (Full phase breakdown included in context interface)
      for (const p of phases) {
        if (validPhasePrice(p) && priceBoundaryComparable(project,item.features,[query,...Object.values(profile).flat()].join(' '),profile) && phaseComparable(p, phases, [query,...Object.values(profile).flat()].join(' '), profile) && !seenPrices.has(`${project.id}_${p.id}`)) {
          seenPrices.add(`${project.id}_${p.id}`);
          priceEvidence.push({
            caseId: project.id,
            phaseName: p.phase_name,
            currency: p.currency,
            amountMin: p.amount_min,
            amountMax: p.amount_max,
            relation: p.relation,
            sourceFileId: p.source_file_id || null,
            sourceType: p.source_type,
            scope: p.scope_description
          });
        }
      }
    }

    return {
      status: 'ok',
      cases: matchedCases,
      styleReferences,
      priceEvidence,
      sampleCount: new Set(priceEvidence.map(p=>p.caseId)).size,
      missingInformation: priceEvidence.length ? [] : ['没有范围明确且获准引用的价格依据，需人工确认阶段、部署与对接条件']
    };
  }
}

/**
 * Detailed scope and boundary evaluation algorithm
 */
function evaluateProjectMatch({ project, features, phases, queryText, profile, tokens }) {
  const normQuery = semanticText(queryText);
  const projectCorpus = [
    project.public_title,
    project.title,
    project.category,
    project.scenario,
    project.public_summary,
    project.deliverables,
    project.integrations,
    project.deployment,
    ...features
  ].map(semanticText).join(' ');

  const strongTitleSignal = hasStrongTitleSignal(project, profile, queryText);

  // 1. Keyword token hit score
  let tokenHits = 0;
  const semanticTokens = extractTokens(normQuery);
  for (const t of semanticTokens) {
    if (projectCorpus.includes(t)) {
      tokenHits++;
    }
  }

  const tokenHitRatio = semanticTokens.length > 0 ? tokenHits / semanticTokens.length : 0;

  // 2. Category compatibility check (Strict Category Anti-Collision)
  // Categories: AI Agent定制, 工作流搭建, 本地大模型部署, 企业级AI Agent落地
  const queryIsLocalDeployment = /本地|私有化|离线|内网|ollama|vllm/u.test(normQuery) && !/不(?:需要|要求)?(?:本地|私有化|离线|内网)/u.test(normQuery);
  const queryIsWorkflow = /工作流|dify|n8n|自动化|流程搭建|触发器/u.test(normQuery);

  const projectIsLocalDeployment = /本地|私有化|内网|离线/u.test(project.category + ' ' + project.deployment);
  const projectIsWorkflow = /工作流/u.test(project.category);

  // Cross-category collision penalty
  let categoryConflict = false;
  if (queryIsLocalDeployment && !projectIsLocalDeployment && !project.category.includes('本地大模型')) {
    categoryConflict = true;
  }
  if (queryIsWorkflow && !projectIsWorkflow && !project.category.includes('工作流')) {
    categoryConflict = true;
  }

  // 3. Feature overlap
  let featureOverlapCount = 0;
  const profileFeatures = Array.isArray(profile.features) ? profile.features : [];
  if (profileFeatures.length > 0) {
    for (const reqFeat of profileFeatures) {
      const featWords = extractTokens(semanticText(reqFeat));
      if (featWords.length && featWords.filter(w => projectCorpus.includes(w)).length / featWords.length >= 0.45) {
        featureOverlapCount++;
      }
    }
  }

  // Determine relevance and match
  const isRelevant = strongTitleSignal || tokenHits >= 2 || (tokenHits >= 1 && semanticTokens.length <= 3);
  const featureCoverage = profileFeatures.length > 0 ? featureOverlapCount / profileFeatures.length : 1;
  const featureGate = profileFeatures.length === 0
    || featureOverlapCount === profileFeatures.length
    || featureCoverage >= 0.6
    || (strongTitleSignal && featureOverlapCount >= 1);

  // Strict match:true criteria
  // 1) Must not have category conflict
  // 2) Must have substantive token hits (>= 2 and ratio >= 0.12, or tokenHits >= 4, or feature overlap)
  // 3) Deployment/boundary constraints must not conflict
  let isMatch = false;
  let reason = '';

  if (!isRelevant) {
    reason = '无可比关键词关联';
  } else if (categoryConflict) {
    reason = `业务类别不匹配（需求关注专项领域，与案例类别 [${project.category}] 交付边界不同）`;
    isMatch = false;
  } else if (!featureGate) {
    reason = '核心功能清单重合度不足';
    isMatch = false;
  } else if (tokenHits >= 2 && (tokenHitRatio >= 0.12 || tokenHits >= 4 || featureOverlapCount >= 1 || strongTitleSignal)) {
    isMatch = true;
    reason = strongTitleSignal
      ? '项目标题与核心交付语义高度一致，价格另校验交付边界；需人工核实实际范围'
      : '类别与核心功能通过关键词规则匹配，价格另校验交付边界；需人工核实实际范围';
  } else {
    reason = '仅召回部分候选词，交付范围不足以直接作为报价依据';
    isMatch = false;
  }

  const score = (tokenHitRatio * 50) + (featureOverlapCount * 25) + (strongTitleSignal ? 20 : 0) + (isMatch ? 30 : 0);

  return {
    isRelevant,
    isMatch,
    score,
    reason
  };
}

// Price eligibility is stricter than recalling a useful proposal. Unknown or
// contradictory delivery boundaries never become a numeric quote by default.
function phaseComparable(phase, phases, query, profile) {
  if (phase.relation === 'unknown') return false;
  const normalized=semanticText(query).replace(/第一期|第1期/gu,'一期').replace(/第二期|第2期/gu,'二期');
  const phaseNames=[...new Set(normalized.match(/(?:[一二三四五六七八九十]+期|第\d+期)/gu)||[])];
  if(phaseNames.length>1&&!/累计|总额|包含|合计/u.test(query))return false;
  const requestedPhase = phaseNames.length===1 ? new RegExp(phaseNames[0],'u') : null;
  if (requestedPhase && !requestedPhase.test(phase.phase_name)) return false;
  if (phase.relation === 'cumulative' && !/累计|总额|含一期|包含一期/u.test(query)) return false;
  if (phase.relation === 'alternative' && !query.includes(phase.phase_name)) return false;
  if (phases.length > 1 && !requestedPhase) {
    const tokens = extractTokens(semanticText(phase.scope_description));
    const hits = tokens.filter(t=>semanticText(query).includes(t));
    if(hits.length < 2) return false;
  }
  return true;
}

function priceBoundaryComparable(project,features,query,profile) {
  const corpus=[project.public_summary,project.integrations,project.deployment,project.deliverables,...features].map(semanticText).join(' ');
  const normalizedQuery=semanticText(query);
  if(/云端|公有云|saas/iu.test(normalizedQuery)&&/纯内网|离线|本地|私有化/u.test(project.deployment)&&!/云端|公有云|saas/iu.test(project.deployment))return false;
  if(profile.integrations?.trim()&&!/^(无|无需|不需要)(对接)?$/u.test(profile.integrations.trim())) {
    const words=extractTokens(semanticText(profile.integrations));
    if(!words.length||words.filter(t=>corpus.includes(t)).length/words.length<0.6)return false;
  }
  const scales=normalizedQuery.match(/\d+(?:\.\d+)?\s*(?:万)?(?:并发|用户|人|台|套|个系统|张|条\/天)/gu)||[];
  if(scales.some(s=>!corpus.replace(/\s/gu,'').includes(s.replace(/\s/gu,''))))return false;
  return true;
}
