import express from 'express';
import crypto from 'node:crypto';
import { getDatabase, transaction } from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';
import { ModelClient } from '../services/modelClient.js';
import { listUpstreamModels, modelsEndpoint } from '../services/modelCatalog.js';

export const settingRouter = express.Router();
settingRouter.use(requireAdmin);

/**
 * Get all system settings (keys masked)
 */
settingRouter.get('/', (req, res) => {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const config = {};
  for (const r of rows) {
    config[r.key] = r.value;
  }

  // Mask sensitive values
  const maskKey = (key) => {
    if (!key || typeof key !== 'string') return '';
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}****${key.slice(-4)}`;
  };

  return res.json({
    settings: {
      model_base_url: config.model_base_url || '',
      model_name: config.model_name || '',
      model_api_key_configured: Boolean(config.model_api_key),
      model_api_key_masked: maskKey(config.model_api_key),
      model_supports_vision: config.model_supports_vision === 'true' || config.model_supports_vision === '1',
      integration_api_key_masked: maskKey(config.integration_api_key),
      max_file_size_mb: Number.parseInt(config.max_file_size_mb, 10) || 50
    }
  });
});

/**
 * Update system settings
 */
settingRouter.put('/', (req, res) => {
  const {
    model_base_url,
    model_name,
    model_api_key,
    model_supports_vision,
    max_file_size_mb
  } = req.body || {};

  const db = getDatabase();
  const now = new Date().toISOString();

  if (model_supports_vision !== undefined && typeof model_supports_vision !== 'boolean') return res.status(400).json({error:'invalid_vision',message:'视觉能力必须是布尔值'});

  if (max_file_size_mb !== undefined && (!Number.isInteger(max_file_size_mb) || max_file_size_mb < 1 || max_file_size_mb > 500)) return res.status(400).json({error:'invalid_limit',message:'文件上限应为1—500MB的整数'});
  if (model_base_url) {
    try { ModelClient.formatEndpoint(model_base_url); } catch { return res.status(400).json({error:'invalid_url',message:'请输入有效的HTTP(S)模型基础地址，不要在地址中填写密钥'}); }
  }

  transaction(() => {
    const upsertStmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    if (typeof model_base_url === 'string') {
      upsertStmt.run('model_base_url', model_base_url.trim(), now);
    }
    if (typeof model_name === 'string') {
      upsertStmt.run('model_name', model_name.trim(), now);
    }
    // Only update API key if non-empty string provided (prevents wiping on save)
    if (typeof model_api_key === 'string' && model_api_key.trim()) {
      upsertStmt.run('model_api_key', model_api_key.trim(), now);
    }
    if (typeof model_supports_vision !== 'undefined') {
      upsertStmt.run('model_supports_vision', model_supports_vision ? 'true' : 'false', now);
    }
    if (typeof max_file_size_mb === 'number' && max_file_size_mb > 0) {
      upsertStmt.run('max_file_size_mb', String(max_file_size_mb), now);
    }
  });

  return res.json({ success: true, message: '系统配置已保存' });
});

/**
 * Discover model IDs using current form values without saving settings.
 */
settingRouter.post('/models', async (req, res, next) => {
  try {
    const saved = ModelClient.getSettings();
    const body = req.body || {};
    if (Array.isArray(body) || typeof body !== 'object' ||
        (body.model_base_url !== undefined && typeof body.model_base_url !== 'string') ||
        (body.model_api_key !== undefined && typeof body.model_api_key !== 'string')) {
      return res.status(400).json({ message: '模型地址和密钥必须是文本' });
    }
    const baseUrl = (body.model_base_url ?? saved.baseUrl).trim();
    const enteredKey = (body.model_api_key || '').trim();
    if (!baseUrl || baseUrl.length > 2048) return res.status(400).json({ message: '请先填写有效的API基础地址' });
    let endpoint;
    try { endpoint = modelsEndpoint(baseUrl); }
    catch { return res.status(400).json({ message: '请输入有效的HTTP(S)基础地址，不要在地址中填写密钥或查询参数' }); }
    if (!enteredKey && saved.apiKey) {
      let savedEndpoint;
      try { savedEndpoint = modelsEndpoint(saved.baseUrl); } catch {}
      if (endpoint !== savedEndpoint) return res.status(400).json({ message: '接口地址已更改，请填写该地址对应的密钥后再获取模型' });
    }
    const apiKey = enteredKey || saved.apiKey.trim();
    if (!apiKey || apiKey.length > 8192 || /[\u0000-\u0020\u007f]/.test(apiKey)) {
      return res.status(400).json({ message: '请填写有效的API密钥；同一已保存地址可留空使用已有密钥' });
    }
    const result = await listUpstreamModels({ baseUrl, apiKey });
    return res.status(result.success ? 200 : result.reason === 'timeout' ? 504 : 502).json(result);
  } catch (err) { next(err); }
});

settingRouter.post('/test-model', async (req, res) => {
  const db = getDatabase();
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('model_base_url', 'model_name', 'model_api_key')").all();
  const config = {};
  for (const r of rows) config[r.key] = r.value;

  const {
    model_base_url = config.model_base_url,
    model_name = config.model_name,
    model_api_key = config.model_api_key
  } = req.body || {};

  const result = await ModelClient.testConnection({
    baseUrl: model_base_url,
    modelName: model_name,
    apiKey: model_api_key || config.model_api_key
  });

  return res.json(result);
});

/**
 * Generate or rotate integration API Key for customer service
 */
settingRouter.post('/generate-integration-key', (req, res) => {
  const newKey = `cs_kb_${crypto.randomBytes(24).toString('hex')}`;
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('integration_api_key', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(newKey, now);

  // Return plaintext ONLY ONCE upon creation
  return res.json({
    success: true,
    apiKey: newKey,
    message: '新密钥已生成，请立即妥善复制保存。之后系统将仅显示掩码。'
  });
});
