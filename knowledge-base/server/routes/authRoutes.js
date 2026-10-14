import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG } from '../config.js';
import { getDatabase, transaction } from '../db/index.js';
import { hashPassword, verifyPassword, createSessionToken, requireAuth, getOrCreateSetupToken } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { isInitialized } from '../middleware/auth.js';

export const authRouter = express.Router();
const loginLimiter = createRateLimiter({ windowMs: 60_000, maxAttempts: 10, message: '登录尝试过于频繁，请稍后再试' });

/**
 * Check whether system has been initialized with an admin
 */
authRouter.get('/status', (req, res) => {
  const db = getDatabase();
  const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND disabled = 0").get().count;
  return res.json({
    initialized: isInitialized()
  });
});

/**
 * Initialize first administrator using ephemeral console setup token
 */
authRouter.post('/init-admin', loginLimiter, (req, res) => {
  const { setupToken, username, password, name } = req.body || {};
  if (![setupToken,username,password,name].every(v=>typeof v==='string'&&v.trim()&&v.length<=1000)) {
    return res.status(400).json({ error: 'invalid_params', message: '所有字段均为必填' });
  }

  const db = getDatabase();
  const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND disabled = 0").get().count;
  if (isInitialized()) {
    return res.status(403).json({ error: 'already_initialized', message: '系统已完成管理员初始化，禁止再次调用' });
  }

  // Verify setup token
  if (!fs.existsSync(CONFIG.SETUP_TOKEN_FILE)) {
    return res.status(403).json({ error: 'invalid_token', message: '未找到初始安装凭证' });
  }

  const fileToken = fs.readFileSync(CONFIG.SETUP_TOKEN_FILE, 'utf8').trim();
  if (setupToken.trim() !== fileToken) {
    return res.status(403).json({ error: 'invalid_token', message: 'Setup Token 错误' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'weak_password', message: '管理员密码长度不得少于 8 位' });
  }

  try {
    const user = transaction(() => {
      const { hash, salt } = hashPassword(password);
      const userId = `usr_admin_${Date.now()}`;
      const now = new Date().toISOString();
      if (isInitialized()) throw new Error('系统已初始化');

      db.prepare(`
        INSERT INTO users (id, username, password_hash, salt, role, name, disabled, token_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'admin', ?, 0, 1, ?, ?)
      `).run(userId, username.trim(), hash, salt, name.trim(), now, now);

      // Initialize default settings if empty
      const defaultIntegrationKey = `cs_kb_${crypto.randomBytes(24).toString('hex')}`;
      db.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('integration_api_key', ?, ?)
      `).run(defaultIntegrationKey, now);
      db.prepare("INSERT OR REPLACE INTO settings VALUES('bootstrap_complete','true',?)").run(now);

      // Safely delete setup token file
      try { fs.unlinkSync(CONFIG.SETUP_TOKEN_FILE); } catch {}

      return {
        id: userId,
        username: username.trim(),
        role: 'admin',
        name: name.trim(),
        token_version: 1
      };
    });

    const token = createSessionToken(user);
    res.cookie(CONFIG.SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: CONFIG.TOKEN_TTL_MS
    });

    return res.json({
      success: true,
      message: '管理员初始化成功',
      user: { id: user.id, username: user.username, role: user.role, name: user.name }
    });
  } catch (err) {
    console.error('Init admin error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

/**
 * Login
 */
authRouter.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (![username,password].every(v=>typeof v==='string'&&v.trim()&&v.length<=1000)) {
    return res.status(400).json({ error: 'invalid_params', message: '用户名与密码不能为空' });
  }

  const db = getDatabase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || user.disabled) {
    return res.status(401).json({ error: 'invalid_credentials', message: '用户名或密码错误' });
  }

  const valid = verifyPassword(password, user.password_hash, user.salt);
  if (!valid) {
    return res.status(401).json({ error: 'invalid_credentials', message: '用户名或密码错误' });
  }

  const token = createSessionToken(user);
  res.cookie(CONFIG.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: CONFIG.TOKEN_TTL_MS
  });

  return res.json({
    success: true,
    user: { id: user.id, username: user.username, role: user.role, name: user.name },
    token // also return in JSON for authorization header fallback
  });
});

/**
 * Current user info
 */
authRouter.get('/me', requireAuth, (req, res) => {
  return res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      name: req.user.name
    }
  });
});

/**
 * Logout
 */
authRouter.post('/logout', (req, res) => {
  res.clearCookie(CONFIG.SESSION_COOKIE_NAME);
  return res.json({ success: true, message: '已安全退出' });
});
