import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDatabase, transaction } from '../db/index.js';
import { CONFIG } from '../config.js';
import { checkVersion, fail, requireIdleProject } from './projectAccess.js';
import { withStagedFiles } from './fileRemoval.js';

export class ReviewService {
  /**
   * Submit draft to pending review queue
   */
  static submitForReview(projectId, userId) {
    const db = getDatabase();
    return transaction(() => {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      if (!project) throw new Error('项目不存在');
      if (project.status === 'approved') throw new Error('该项目已处于已发布状态');
      if (db.prepare("SELECT 1 FROM tasks WHERE project_id=? AND status IN ('pending','running')").get(projectId)) fail('task_running', '请等待整理或解析结束后再提交审核');

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE projects 
        SET status = 'pending_review', updated_at = ?
        WHERE id = ?
      `).run(now, projectId);

      const auditId = `audit_${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO audit_logs (id, user_id, action, target_type, target_id, details_json, created_at)
        VALUES (?, ?, 'submit_review', 'project', ?, '{}', ?)
      `).run(auditId, userId, projectId, now);

      return { success: true, status: 'pending_review' };
    });
  }

  /**
   * Approve project into formal knowledge base with draft snapshot check
   */
  static approveProject(projectId, reviewerId, clientDraftVersion, notes = '') {
    const db = getDatabase();
    return transaction(() => {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      if (!project) throw new Error('项目不存在');
      if (project.deleted_at) throw new Error('该项目已被删除');

      // Version concurrency check: ensure reviewer approved what they actually saw
      checkVersion(project, clientDraftVersion);
      if (project.status !== 'pending_review') fail('invalid_status', '仅待审核项目可以发布，请先提交审核');
      if (db.prepare("SELECT 1 FROM tasks WHERE project_id=? AND status IN ('pending','running')").get(projectId)) fail('task_running', '整理任务尚未结束，不能审批');

      const phases = db.prepare('SELECT * FROM project_phases WHERE project_id = ? ORDER BY order_index ASC').all(projectId);
      const features = db.prepare('SELECT feature_text FROM project_features WHERE project_id = ? ORDER BY order_index ASC').all(projectId);
      const styles = db.prepare('SELECT * FROM style_references WHERE project_id = ?').all(projectId);

      const snapshot = {
        title: project.title,
        public_title: project.public_title,
        public_summary: project.public_summary,
        category: project.category,
        scenario: project.scenario,
        problem: project.problem,
        overview: project.overview,
        inputs: project.inputs,
        outputs: project.outputs,
        integrations: project.integrations,
        deployment: project.deployment,
        deliverables: project.deliverables,
        exclusions: project.exclusions,
        features: features.map(f => f.feature_text),
        phases,
        styles,
        approved_by: reviewerId,
        approved_at: new Date().toISOString()
      };

      const now = new Date().toISOString();

      // Update project status to approved
      db.prepare(`
        UPDATE projects 
        SET status = 'approved',
            approved_by = ?,
            approved_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(reviewerId, now, now, projectId);

      // Record in project_reviews
      const reviewId = `rev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      db.prepare(`
        INSERT INTO project_reviews (id, project_id, reviewer_id, action, reason, snapshot_json, created_at)
        VALUES (?, ?, ?, 'approved', ?, ?, ?)
      `).run(reviewId, projectId, reviewerId, notes, JSON.stringify(snapshot), now);

      // Sync FTS table
      db.prepare('DELETE FROM projects_fts WHERE project_id = ?').run(projectId);
      db.prepare(`
        INSERT INTO projects_fts (project_id, title, category, scenario, overview, features, deliverables)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        project.public_title || project.title,
        project.category,
        project.scenario,
        project.public_summary || project.overview,
        features.map(f => f.feature_text).join(' '),
        project.deliverables
      );

      // Audit log
      const auditId = `audit_${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO audit_logs (id, user_id, action, target_type, target_id, details_json, created_at)
        VALUES (?, ?, 'approve_project', 'project', ?, ?, ?)
      `).run(auditId, reviewerId, projectId, JSON.stringify({ reviewId }), now);

      return { success: true, status: 'approved', reviewId };
    });
  }

  /**
   * Return project to draft with reason
   */
  static returnProject(projectId, reviewerId, reason) {
    const db = getDatabase();
    return transaction(() => {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      if (!project) throw new Error('项目不存在');

      if (project.status !== 'pending_review') fail('invalid_status', '仅待审核项目可以退回');

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE projects 
        SET status = 'returned', updated_at = ?
        WHERE id = ?
      `).run(now, projectId);

      const reviewId = `rev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      db.prepare(`
        INSERT INTO project_reviews (id, project_id, reviewer_id, action, reason, snapshot_json, created_at)
        VALUES (?, ?, ?, 'returned', ?, '{}', ?)
      `).run(reviewId, projectId, reviewerId, reason || '审核退回', now);

      // Remove from FTS if it was present
      db.prepare('DELETE FROM projects_fts WHERE project_id = ?').run(projectId);

      const auditId = `audit_${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO audit_logs (id, user_id, action, target_type, target_id, details_json, created_at)
        VALUES (?, ?, 'return_project', 'project', ?, ?, ?)
      `).run(auditId, reviewerId, projectId, JSON.stringify({ reason }), now);

      return { success: true, status: 'returned' };
    });
  }

  /**
   * Revoke an approved project back to revoked status
   * Allowed for: project creator, any staff who previously reviewed/approved it, or admin
   */
  static revokeProject(projectId, user, reason) {
    const db = getDatabase();
    return transaction(() => {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      if (!project) throw new Error('项目不存在');
      if (project.status !== 'approved') throw new Error('该项目未处于已发布状态');
      if (typeof reason !== 'string' || !reason.trim()) fail('reason_required', '请填写撤回原因', 400);

      // Check permission
      const isCreator = project.creator_id === user.id;
      const isAdmin = user.role === 'admin';
      const isReviewer = Boolean(db.prepare(`
        SELECT 1 FROM project_reviews 
        WHERE project_id = ? AND reviewer_id = ? AND action = 'approved'
      `).get(projectId, user.id));

      if (!isCreator && !isAdmin && !isReviewer) {
        const error = new Error('无权撤回：仅项目提交人、审核人或管理员可以撤回已发布案例');
        error.code = 'forbidden';
        throw error;
      }

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE projects 
        SET status = 'revoked', updated_at = ?
        WHERE id = ?
      `).run(now, projectId);

      // Instantly remove from FTS search index
      db.prepare('DELETE FROM projects_fts WHERE project_id = ?').run(projectId);

      const reviewId = `rev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      db.prepare(`
        INSERT INTO project_reviews (id, project_id, reviewer_id, action, reason, snapshot_json, created_at)
        VALUES (?, ?, ?, 'revoked', ?, '{}', ?)
      `).run(reviewId, projectId, user.id, reason || '案例已撤回', now);

      const auditId = `audit_${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO audit_logs (id, user_id, action, target_type, target_id, details_json, created_at)
        VALUES (?, ?, 'revoke_project', 'project', ?, ?, ?)
      `).run(auditId, user.id, projectId, JSON.stringify({ reason }), now);

      return { success: true, status: 'revoked' };
    });
  }

  /**
   * Permanent physical deletion (admin only)
   */
  static permanentDelete(projectId, adminUser) {
    if (adminUser.role !== 'admin') {
      const error = new Error('仅管理员有权永久删除正式案例');
      error.code = 'forbidden';
      throw error;
    }

    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) fail('not_found', '项目不存在', 404);
    requireIdleProject(projectId);
    const files = db.prepare('SELECT stored_filename FROM project_files WHERE project_id=?').all(projectId);
    const cleanupPending = withStagedFiles(files.map(f=>f.stored_filename), () => transaction(() => {
      db.prepare('DELETE FROM projects_fts WHERE project_id=?').run(projectId);
      db.prepare('DELETE FROM tasks WHERE project_id=?').run(projectId);
      db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
      db.prepare("INSERT INTO audit_logs VALUES(?,?,'permanent_delete','project',?,'{}',datetime('now'))").run(`audit_${crypto.randomUUID()}`,adminUser.id,projectId);
    }));
    return {success:true,deleted:true,cleanupPending,message:cleanupPending?'案例已下架，但原件清理未完成，请管理员处理deletion-pending目录':'案例与原件已删除；已有备份不受影响'};
  }
}
