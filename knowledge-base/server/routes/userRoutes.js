import express from 'express';
import crypto from 'node:crypto';
import { getDatabase, transaction } from '../db/index.js';
import { requireAdmin, hashPassword } from '../middleware/auth.js';

export const userRouter = express.Router();
userRouter.use(requireAdmin);

/**
 * List all users (admin only)
 */
userRouter.get('/', (req, res) => {
  const db = getDatabase();
  const users = db.prepare(`
    SELECT id, username, role, name, disabled, created_at, updated_at 
    FROM users 
    ORDER BY created_at DESC
  `).all();
  return res.json({ users });
});

/**
 * Create a new staff or admin user
 */
userRouter.post('/', (req, res) => {
  const { username, password, name, role = 'staff' } = req.body || {};
  if (typeof username!=='string'||!username.trim()||username.length>200||typeof password!=='string'||password.length>1024||typeof name!=='string'||!name.trim()||name.length>200) {
    return res.status(400).json({ error: 'invalid_params', message: '用户名、密码与姓名均为必填' });
  }

  if (!['admin', 'staff'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role', message: '角色必须为 admin 或 staff' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'weak_password', message: '密码长度至少 6 位' });
  }

  const db = getDatabase();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    return res.status(400).json({ error: 'username_exists', message: '该用户名已存在' });
  }

  const { hash, salt } = hashPassword(password);
  const id = `usr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, role, name, disabled, token_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(id, username.trim(), hash, salt, role, name.trim(), now, now);

  return res.json({
    success: true,
    user: { id, username: username.trim(), role, name: name.trim(), disabled: 0 }
  });
});

/**
 * Update user (status, role, reset password)
 */
userRouter.put('/:id', (req, res) => {
  const targetId = req.params.id;
  const { disabled, role, name, newPassword } = req.body || {};
  if ((disabled!==undefined && ![0,1,false,true].includes(disabled)) || (role!==undefined && !['admin','staff'].includes(role)) || (name!==undefined && (typeof name!=='string'||!name.trim()||name.length>200)) || (newPassword!==undefined && (typeof newPassword!=='string'||newPassword.length<6||newPassword.length>1024))) return res.status(400).json({error:'invalid_params',message:'账号字段格式错误；密码至少6位，状态仅允许启用或停用'});

  const db = getDatabase();
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!targetUser) {
    return res.status(404).json({ error: 'not_found', message: '用户不存在' });
  }

  // Prevent disabling the last active admin
  if (targetUser.role === 'admin' && !targetUser.disabled && (disabled === 1 || disabled === true || role === 'staff')) {
    const activeAdmins = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND disabled = 0").get().count;
    if (activeAdmins <= 1) {
      return res.status(400).json({ error: 'cannot_disable', message: '系统中至少保留一位有效管理员' });
    }
  }

  transaction(() => {
    const updates = [];
    const params = [];

    if (typeof disabled === 'number' || typeof disabled === 'boolean') {
      updates.push('disabled = ?');
      params.push(disabled ? 1 : 0);
    }

    if (role && ['admin', 'staff'].includes(role)) {
      updates.push('role = ?');
      params.push(role);
    }

    if (typeof name === 'string' && name.trim()) {
      updates.push('name = ?');
      params.push(name.trim());
    }

    if (typeof newPassword === 'string' && newPassword.length >= 6) {
      const { hash, salt } = hashPassword(newPassword);
      updates.push('password_hash = ?', 'salt = ?');
      params.push(hash, salt);
    }

    // Bump token_version so existing sessions for this user expire immediately
    updates.push('token_version = token_version + 1', "updated_at = datetime('now')");
    params.push(targetId);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  });

  return res.json({ success: true, message: '用户信息已更新' });
});
