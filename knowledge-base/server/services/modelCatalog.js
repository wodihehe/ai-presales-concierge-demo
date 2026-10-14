import { ModelClient } from './modelClient.js';

export function modelsEndpoint(baseUrl) {
  return ModelClient.formatEndpoint(baseUrl).replace(/\/chat\/completions$/, '/models');
}

// Read-only discovery: no chat request, database write, or capability inference.
export async function listUpstreamModels({ baseUrl, apiKey }, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const failure = (reason, message) => ({ success: false, reason, message });
  try {
    const response = await fetch(modelsEndpoint(baseUrl), {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) return failure('upstream_auth', '上游拒绝授权，请检查密钥及模型列表访问权限');
      if ([404, 405].includes(response.status)) return failure('unsupported', '该地址未提供兼容的模型列表接口，请检查地址或手动填写模型名称');
      if (response.status === 429) return failure('rate_limited', '上游请求过于频繁，请稍后重试');
      return failure('upstream_error', `获取模型失败（HTTP ${response.status}），可稍后重试或手动填写`);
    }
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) {
        controller.abort();
        return failure('response_too_large', '上游模型列表超过2MB，请手动填写模型名称');
      }
      chunks.push(Buffer.from(value));
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return failure('invalid_response', '上游未返回有效的模型列表，请检查地址或手动填写'); }
    if (!Array.isArray(data?.data)) return failure('invalid_response', '上游模型列表格式不兼容，可手动填写模型名称');
    if (data.data.length > 5000) return failure('too_many_models', '上游模型列表超过5000条，请手动填写模型名称');
    const ids = new Set();
    let skippedCount = 0;
    for (const item of data.data) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id) || id.includes(apiKey)) {
        skippedCount++;
        continue;
      }
      ids.add(id);
    }
    if (data.data.length && !ids.size) return failure('invalid_response', '上游没有返回有效的模型ID，可手动填写模型名称');
    return { success: true, models: [...ids].sort((a, b) => a.localeCompare(b)), skippedCount };
  } catch {
    return controller.signal.aborted
      ? failure('timeout', '获取模型列表超时，请稍后重试或手动填写')
      : failure('network_error', '无法连接上游模型列表接口，请检查地址及网络；不支持跳转地址');
  } finally { clearTimeout(timer); }
}
