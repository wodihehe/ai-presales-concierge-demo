import { getDatabase } from '../db/index.js';

export function fail(code, message, status = 409) {
  throw Object.assign(new Error(message), { code, status });
}

export function writableProject(projectId, userId) {
  const db = getDatabase();
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId);
  if (!p) fail('not_found', '项目不存在或已删除', 404);
  const user = db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(userId);
  if (!user || user.disabled || (p.creator_id !== userId && user.role !== 'admin')) fail('forbidden', '仅提交人或管理员可以修改本项目', 403);
  if (p.status === 'approved') fail('published_locked', '请先撤回已发布案例，再修改并重新审核');
  return p;
}

export function checkVersion(project, version) {
  if (!Number.isSafeInteger(version) || version < 1 || project.draft_version !== version) {
    fail('draft_stale', '草稿内容已变更或缺少审核版本，请刷新后重新核对');
  }
}

export function invalidateDraft(projectId) {
  const db = getDatabase();
  db.prepare("UPDATE projects SET status='draft', draft_version=draft_version+1, approved_by=NULL, approved_at=NULL, updated_at=datetime('now') WHERE id=?").run(projectId);
  db.prepare('DELETE FROM projects_fts WHERE project_id=?').run(projectId);
}

export function requireIdleProject(projectId) {
  if (getDatabase().prepare("SELECT 1 FROM tasks WHERE project_id=? AND status IN ('pending','running')").get(projectId)) {
    fail('task_running', '本项目有处理中任务，请等待完成后再操作');
  }
}

export function requireProjectEditor(req, res, next) {
  try { req.editProject = writableProject(req.params.id, req.user.id); next(); }
  catch (err) { res.status(err.status || 400).json({ error: err.code || 'invalid_project', message: err.message }); }
}
