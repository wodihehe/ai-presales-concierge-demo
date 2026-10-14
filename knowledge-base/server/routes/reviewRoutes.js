import express from 'express';
import { getDatabase } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { ReviewService } from '../services/reviewService.js';
import { requireProjectEditor } from '../services/projectAccess.js';

export const reviewRouter = express.Router();
reviewRouter.use(requireAuth);

/**
 * Get review queue (pending review projects)
 */
reviewRouter.get('/queue', (req, res) => {
  const db = getDatabase();
  const projects = db.prepare(`
    SELECT p.*, u.name as creator_name,
           (SELECT COUNT(*) FROM project_files WHERE project_id = p.id) as fileCount
    FROM projects p
    LEFT JOIN users u ON p.creator_id = u.id
    WHERE p.status = 'pending_review' AND p.deleted_at IS NULL
    ORDER BY p.updated_at ASC
  `).all();

  return res.json({ queue: projects });
});

/**
 * Submit draft to review
 */
reviewRouter.post('/:id/submit', requireProjectEditor, (req, res) => {
  const projectId = req.params.id;
  try {
    const result = ReviewService.submitForReview(projectId, req.user.id);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: 'submit_failed', message: err.message });
  }
});

/**
 * Approve project and publish to formal knowledge base
 */
reviewRouter.post('/:id/approve', (req, res) => {
  const projectId = req.params.id;
  const { clientDraftVersion, notes } = req.body || {};

  try {
    const result = ReviewService.approveProject(projectId, req.user.id, clientDraftVersion, notes);
    return res.json(result);
  } catch (err) {
    const status = err.status || (err.code === 'draft_stale' ? 409 : 400);
    return res.status(status).json({ error: err.code || 'approve_failed', message: err.message });
  }
});

/**
 * Return project for revisions
 */
reviewRouter.post('/:id/return', (req, res) => {
  const projectId = req.params.id;
  const { reason } = req.body || {};

  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'invalid_params', message: '请填写退回修改原因' });
  }

  try {
    const result = ReviewService.returnProject(projectId, req.user.id, reason.trim());
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: 'return_failed', message: err.message });
  }
});

/**
 * Revoke an approved project back to revoked
 */
reviewRouter.post('/:id/revoke', (req, res) => {
  const projectId = req.params.id;
  const { reason } = req.body || {};

  try {
    const result = ReviewService.revokeProject(projectId, req.user, reason);
    return res.json(result);
  } catch (err) {
    const status = err.code === 'forbidden' ? 403 : 400;
    return res.status(status).json({ error: err.code || 'revoke_failed', message: err.message });
  }
});

/**
 * Permanent deletion (admin only)
 */
reviewRouter.delete('/:id', (req, res) => {
  const projectId = req.params.id;
  try {
    const result = ReviewService.permanentDelete(projectId, req.user);
    return res.json(result);
  } catch (err) {
    const status = err.code === 'forbidden' ? 403 : 400;
    return res.status(status).json({ error: err.code || 'delete_failed', message: err.message });
  }
});
