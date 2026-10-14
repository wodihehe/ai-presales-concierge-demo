import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { OrganizerService } from '../services/organizerService.js';
import { requireProjectEditor } from '../services/projectAccess.js';

export const organizeRouter = express.Router();
organizeRouter.use(requireAuth);

/**
 * Trigger AI extraction from project's uploaded files
 */
organizeRouter.post('/:id/extract', requireProjectEditor, async (req, res) => {
  const projectId = req.params.id;
  try {
    const result = await OrganizerService.extractDraft(projectId, req.user.id);
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.code || 'extract_failed', message: err.status ? err.message : '整理失败，已有资料保留' });
  }
});

/**
 * Chat with project AI organizer
 */
organizeRouter.post('/:id/chat', requireProjectEditor, async (req, res) => {
  const projectId = req.params.id;
  const { message, clientDraftVersion } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim() || message.length > 20000) {
    return res.status(400).json({ error: 'invalid_params', message: '消息内容不能为空' });
  }

  try {
    const result = await OrganizerService.handleChat(projectId, req.user.id, message.trim(), clientDraftVersion);
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.code || 'chat_failed', message: err.status ? err.message : '整理失败，原稿已保留' });
  }
});
