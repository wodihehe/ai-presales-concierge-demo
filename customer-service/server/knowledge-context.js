/** Read only reviewed, public proposal context from our known KB contract.
 * This channel never grants quote authority and never follows upstream URLs.
 */
const CONTEXT_PATH = '/api/integrations/customer-service/context';
const SEARCH_PATH = '/api/integrations/customer-service/search';
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CONTEXT_CHARS = 12_000;
const PROFILE_LIMITS = { project: 160, scenario: 800, problem: 1600, inputs: 1200, outputs: 1200, integrations: 1200 };
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MONEY = /(?:[¥￥$€£]|\b(?:CNY|RMB|USD|EUR|HKD)\b)\s*[\d一二三四五六七八九十百千万]|[\d一二三四五六七八九十百千万](?:[\d,.，\s—–~至到-]*[\d一二三四五六七八九十百千万])?\s*(?:万|千|百)?\s*(?:元|块钱|美元|人民币|港币|港元|欧元|CNY\b|RMB\b|USD\b|EUR\b|HKD\b)|(?:报价|价格|费用|成本|预算|金额)\s*[:：为是约]?\s*\d/iu;
const CONTACT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:^|\D)1[3-9]\d{9}(?:\D|$)|(?:微信|手机号|电话|邮箱|wechat)\s*[:：]\s*\S+/iu;
export const containsReferenceMoney = value => typeof value === 'string' && MONEY.test(value);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = status => ({ status, cases: [], styleReferences: [], sources: [] });

export function resolveKnowledgeContextUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[?#]/u.test(value) || CONTROL_CHARACTERS.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) return null;
    // Exact, recognized suffix only. A prefix allows reverse-proxy mounting,
    // but arbitrary third-party /search endpoints are never guessed.
    if (url.pathname.endsWith(SEARCH_PATH)) url.pathname = url.pathname.slice(0, -SEARCH_PATH.length) + CONTEXT_PATH;
    else if (!url.pathname.endsWith(CONTEXT_PATH)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function configuredSecrets(settings) {
  const secrets = new Set();
  const visit = (value, depth = 0) => {
    if (!isRecord(value) || depth > 5) return;
    for (const [name, entry] of Object.entries(value)) {
      if (typeof entry === 'string' && /api.?key|secret|password|token|webhook/iu.test(name) && entry.trim()) {
        secrets.add(entry.trim());
        secrets.add(encodeURIComponent(entry.trim()));
        if (/webhook/iu.test(name)) {
          try {
            for (const secret of new URL(entry).searchParams.values()) {
              if (secret) { secrets.add(secret); secrets.add(encodeURIComponent(secret)); }
            }
          } catch { /* a malformed secret must still stay secret */ }
        }
      } else if (isRecord(entry)) visit(entry, depth + 1);
    }
  };
  visit(settings);
  return [...secrets];
}

function safeText(value, limit, secrets, { allowEmpty = false, excludeMoney = false } = {}) {
  // Reject the whole value instead of truncating away exclusions or boundaries.
  if (typeof value !== 'string' || value.length > limit || CONTROL_CHARACTERS.test(value)) return null;
  const text = value.trim();
  if ((!text && !allowEmpty) || secrets.some(secret => text.includes(secret)) || CONTACT.test(text) || (excludeMoney && MONEY.test(text))) return null;
  return text;
}

function queryProfile(profile, secrets) {
  const result = {};
  if (!isRecord(profile)) return result;
  for (const [field, limit] of Object.entries(PROFILE_LIMITS)) {
    const value = safeText(profile[field], limit, secrets);
    if (value && !CONTACT.test(value)) result[field] = value;
  }
  if (Array.isArray(profile.features) && profile.features.length <= 20) {
    const features = profile.features.map(value => safeText(value, 300, secrets));
    // A partial feature list could omit an explicit restriction.
    if (features.every(value => value !== null && !CONTACT.test(value))) result.features = [...new Set(features)];
  }
  return result;
}

async function readResponse(response, signal) {
  if (!response || response.ok !== true || response.redirected === true) throw new Error('response_failed');
  const contentType = response.headers?.get?.('content-type') || '';
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/iu.test(contentType)) throw new Error('response_type');
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new Error('response_size');
  if (!response.body?.getReader) throw new Error('response_body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  // Cancel the reader as well as fetch: the deadline covers a stalled body.
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new Error('response_timeout');
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('response_timeout');
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('response_type');
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('response_size');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function filterContext(body, secrets) {
  if (!isRecord(body) || !['ok', 'no_match'].includes(body.status)
    || !Array.isArray(body.cases) || body.cases.length > 1000
    || !Array.isArray(body.styleReferences) || body.styleReferences.length > 1000) return empty('unavailable');
  if (body.status === 'no_match') return empty('no_match');
  const cases = [];
  const projectIds = new Set();
  let remaining = MAX_CONTEXT_CHARS;
  for (const candidate of body.cases) {
    if (cases.length >= 3) break;
    if (!isRecord(candidate) || candidate.approved !== true || candidate.public !== true || candidate.match !== true) continue;
    const id = safeText(candidate.id, 128, secrets);
    const title = safeText(candidate.title, 300, secrets, { excludeMoney: true });
    const summary = safeText(candidate.summary, 4000, secrets, { allowEmpty: true, excludeMoney: true });
    if (!id || !/^[\p{L}\p{N}_.:#-]+$/u.test(id) || !title || summary === null
      || !Array.isArray(candidate.features) || candidate.features.length > 100) continue;
    const features = candidate.features.map(feature => safeText(feature, 1000, secrets, { excludeMoney: true }));
    if (features.some(feature => feature === null)) continue;
    const projectId = id.split('#', 1)[0];
    if (!projectId || projectIds.has(projectId)) continue;
    const item = { id, projectId, title, summary, features };
    const size = JSON.stringify(item).length;
    if (size > remaining) continue;
    remaining -= size;
    cases.push(item);
    projectIds.add(projectId);
  }
  if (cases.length === 0) return empty('no_match');
  const styleReferences = [];
  const seen = new Set();
  for (const style of body.styleReferences) {
    if (styleReferences.length >= 6) break;
    if (!isRecord(style)) continue;
    const caseId = safeText(style.caseId, 128, secrets);
    const topic = safeText(style.topic, 200, secrets, { excludeMoney: true });
    const example = safeText(style.example, 3000, secrets, { excludeMoney: true });
    if (!caseId || !projectIds.has(caseId) || !topic || !example) continue;
    const item = { caseId, topic, example };
    const encoded = JSON.stringify(item);
    if (seen.has(encoded) || encoded.length > remaining) continue;
    remaining -= encoded.length;
    seen.add(encoded);
    styleReferences.push(item);
  }
  return { status: 'ok', cases, styleReferences, sources: cases.map(item => item.id) };
}

export async function retrieveKnowledgeContext({ settings, profile = {}, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const configuredUrl = settings?.knowledge?.url;
  if (typeof configuredUrl !== 'string' || !configuredUrl.trim()) return empty('not_configured');
  const url = resolveKnowledgeContextUrl(configuredUrl);
  if (!url) return empty('unsupported');
  const secrets = configuredSecrets(settings);
  const clean = queryProfile(profile, secrets);
  const query = [clean.project, clean.scenario, clean.problem, ...(clean.features || []), clean.inputs, clean.outputs, clean.integrations].filter(Boolean).join('\n');
  if (!query) return empty('no_match');
  const controller = new AbortController();
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 5000)) : 5000;
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('context_timeout')); }, duration);
    });
    const response = await Promise.race([
      (async () => {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        const apiKey = settings?.knowledge?.apiKey;
        if (typeof apiKey === 'string' && apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
        const result = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ query, profile: clean }), signal: controller.signal, redirect: 'error' });
        return readResponse(result, controller.signal);
      })(),
      timeout,
    ]);
    return filterContext(response, secrets);
  } catch {
    // Never surface transport errors or upstream bodies: they may contain keys.
    return empty('unavailable');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
