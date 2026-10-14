import crypto from 'node:crypto';
import { getDatabase } from '../db/index.js';

export class TaskQueue {
  static createTask(projectId, type) {
    const db = getDatabase();
    const id = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    
    db.prepare(`
      INSERT INTO tasks (id, project_id, type, status, progress, error_message, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0.0, '', ?, ?)
    `).run(id, projectId, type, now, now);

    return TaskQueue.getTask(id);
  }

  static startTask(taskId) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks 
      SET status = 'running', updated_at = ?
      WHERE id = ?
    `).run(now, taskId);
  }

  static updateProgress(taskId, progress) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks 
      SET progress = ?, updated_at = ?
      WHERE id = ?
    `).run(progress, now, taskId);
  }

  static completeTask(taskId) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks 
      SET status = 'success', progress = 1.0, updated_at = ?
      WHERE id = ?
    `).run(now, taskId);
  }

  static failTask(taskId, errorMessage) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks 
      SET status = 'failed', error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(errorMessage || '任务处理失败', now, taskId);
  }

  static getTask(taskId) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  }

  static getProjectTasks(projectId) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').all(projectId);
  }
}
