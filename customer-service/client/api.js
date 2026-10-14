export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 95000);
  const { body, timeout: _timeout, ...rest } = options;
  const multipart = body instanceof FormData;
  try {
    const response = await fetch(path, {
      credentials: 'include', ...rest, signal: controller.signal,
      headers: { ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
      body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path.startsWith('/api/admin/') && !path.endsWith('/login') && !path.endsWith('/me')) window.dispatchEvent(new Event('admin-session-expired'));
      throw new ApiError(t(data.error || `请求未完成，请稍后重试（${response.status}）`,getLocale()), response.status);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new ApiError('等待时间有点长，请重试。你的输入仍然保留着。', 408);
    if (error instanceof ApiError) throw error;
    throw new ApiError('暂时连接不上服务，请检查网络后重试。', 0);
  } finally { clearTimeout(timeout); }
}

export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const followupLabels = { pending: '待跟进', following: '跟进中', won: '已成交', lost: '暂不考虑' };
export const feedbackLabels = { not_quoted: '尚未报价', accepted: '接受参考区间', too_high: '觉得价格偏高', considering: '待考虑' };
export const knowledgeLabels = { not_configured: '待人工评估', unavailable: '报价依据暂不可用', no_match: '新类型项目 · 待人工评估', no_price: '缺少价格依据', quoted: '已生成参考区间' };
export const notificationLabels = { pending: '等待记录演示通知', processing: '正在记录', sending: '正在记录', retrying: '等待重试', sent: '已记录本地演示通知', failed: '记录失败', not_configured: '演示通知待配置', awaiting_configuration: '演示通知待配置', superseded: '已被新版本替代', cancelled: '已取消' };
export const formatDate = value => value ? new Intl.DateTimeFormat(getLocale()==='en'?'en-GB':'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
export const formatMoney = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
export const formatBytes = bytes => bytes >= 1000000 ? `${(bytes / 1000000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
import {getLocale} from '../../shared/browser-locale.js';
import {t} from '../../shared/i18n.js';
