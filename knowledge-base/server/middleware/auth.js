import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG } from '../config.js';
import { getDatabase } from '../db/index.js';

const HMAC_SECRET = crypto.randomBytes(32).toString('hex');

/**
 * Hash password with salt using PBKDF2
 */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const computed = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

/**
 * Sign session payload: base64(payload).signature
 */
export function createSessionToken(user) {
  const payload = {
    userId: user.id,
    username: user.username,
    role: user.role,
    tokenVersion: user.token_version,
    exp: Date.now() + CONFIG.TOKEN_TTL_MS
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('base64url');
  return `${data}.${hmac}`;
}

export function verifySessionToken(tokenString) {
  if (!tokenString || typeof tokenString !== 'string') return null;
  const parts = tokenString.split('.');
  if (parts.length !== 2) return null;
  const [data, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('base64url');
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expectedSig)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Setup Token generation and verification for initial admin bootstrap
 */
export function isInitialized() {
  const db = getDatabase();
  return !!db.prepare("SELECT 1 FROM settings WHERE key='bootstrap_complete' AND value='true'").get() || db.prepare('SELECT COUNT(*) n FROM users').get().n > 0;
}
export function getOrCreateSetupToken() {
  const db = getDatabase();
  const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND disabled = 0").get().count;
  if (isInitialized()) {
    if (fs.existsSync(CONFIG.SETUP_TOKEN_FILE)) {
      try { fs.unlinkSync(CONFIG.SETUP_TOKEN_FILE); } catch {}
    }
    return null; // Already initialized
  }

  if (fs.existsSync(CONFIG.SETUP_TOKEN_FILE)) {
    const token = fs.readFileSync(CONFIG.SETUP_TOKEN_FILE, 'utf8').trim();
    if (token) return token;
  }

  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(CONFIG.SETUP_TOKEN_FILE, token, { mode: 0o600, encoding: 'utf8' });
  console.log('\n======================================================');
  console.log('[SETUP] 首次启动：系统尚未初始化管理员账号！');
  console.log('[SETUP] 本机安全初始化 Setup Token:');
  console.log(`[SETUP] ${token}`);
  console.log('======================================================\n');
  return token;
}

/**
 * Express middleware to authenticate session from Cookie or Authorization header
 */
export function requireAuth(req, res, next) {
  let token = req.cookies?.[CONFIG.SESSION_COOKIE_NAME];
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7).trim();
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'unauthorized', message: '请先登录' });
  }

  const db = getDatabase();
  const user = db.prepare('SELECT id, username, role, name, disabled, token_version FROM users WHERE id = ?').get(payload.userId);
  if (!user || user.disabled) {
    return res.status(401).json({ error: 'unauthorized', message: '账号不存在或已被停用' });
  }

  if (user.token_version !== payload.tokenVersion) {
    return res.status(401).json({ error: 'session_expired', message: '权限或密码已变更，请重新登录' });
  }

  req.user = user;
  next();
}

/**
 * Express middleware to restrict to administrators
 */
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', message: '仅管理员有权执行此操作' });
    }
    next();
  });
}

/**
 * Customer Service Integration API Key Auth
 */
export function requireIntegrationKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: '缺少接口授权凭据' });
  }

  const key = authHeader.slice(7).trim();
  if (!key) {
    return res.status(401).json({ error: 'unauthorized', message: '授权凭据为空' });
  }

  const db = getDatabase();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'integration_api_key'").get();
  if (!row || !row.value) {
    return res.status(503).json({ error: 'not_configured', message: '知识库服务未配置集成密钥' });
  }

  const expectedKey = row.value.trim();
  if (Buffer.byteLength(key) !== Buffer.byteLength(expectedKey)) {
    return res.status(403).json({ error: 'forbidden', message: '接口授权凭据无效' });
  }

  if (!crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expectedKey))) {
    return res.status(403).json({ error: 'forbidden', message: '接口授权凭据无效' });
  }

  next();
}
