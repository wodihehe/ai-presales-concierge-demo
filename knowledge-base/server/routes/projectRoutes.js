import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG } from '../config.js';
import { getDatabase, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { extractDocumentText } from '../services/fileParser.js';
import { OrganizerService } from '../services/organizerService.js';
import { TaskQueue } from '../services/taskQueue.js';
import { requireProjectEditor, writableProject, invalidateDraft, requireIdleProject } from '../services/projectAccess.js';

import { withStagedFiles } from '../services/fileRemoval.js';

export const projectRouter = express.Router();
projectRouter.use(requireAuth);

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, CONFIG.UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const unique = `upload_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${safeExt}`;
    cb(null, unique);
  }
});

function uploadFiles(req,res,next) {
  const limit=Number(getDatabase().prepare("SELECT value FROM settings WHERE key='max_file_size_mb'").get()?.value);
  const fileSize=Number.isInteger(limit)&&limit>=1&&limit<=500 ? limit*1024*1024 : CONFIG.MAX_FILE_SIZE_BYTES;
  multer({storage,limits:{fileSize,files:10,fields:10,parts:20}}).array('files',10)(req,res,next);
}

projectRouter.post('/:id/files/:fileId/reparse', requireProjectEditor, async (req,res,next)=>{
  const db=getDatabase();
  const file=db.prepare('SELECT * FROM project_files WHERE id=? AND project_id=?').get(req.params.fileId,req.params.id);
  if(!file)return res.status(404).json({error:'not_found',message:'附件不存在'});
  try { requireIdleProject(req.params.id); } catch(err) { return next(err); }
  const task=TaskQueue.createTask(req.params.id,'file_parse');
  TaskQueue.startTask(task.id);
  invalidateDraft(req.params.id);
  db.prepare("UPDATE project_files SET parse_status='pending' WHERE id=?").run(file.id);
  try {
    const result=await extractDocumentText(path.join(CONFIG.UPLOAD_DIR,file.stored_filename),file.original_name,file.mime_type);
    writableProject(req.params.id,req.user.id);
    db.prepare('UPDATE project_files SET parse_status=?,extracted_text=?,parse_error_reason=? WHERE id=?').run(result.parse_status,result.extracted_text,result.parse_error_reason,file.id);
    invalidateDraft(req.params.id);
    if(result.parse_status==='failed')TaskQueue.failTask(task.id,result.parse_error_reason);else TaskQueue.completeTask(task.id);
    res.json({success:result.parse_status!=='failed',message:result.parse_error_reason||'重新解析完成'});
  }catch(err){TaskQueue.failTask(task.id,'解析失败，原件保留');db.prepare("UPDATE project_files SET parse_status='failed',parse_error_reason='解析失败，原件保留，请重试' WHERE id=?").run(file.id);next(err);}
});

/**
 * List projects (filtered by status, keyword, category)
 */
projectRouter.get('/', (req, res) => {
  const { status, keyword, category } = req.query;
  const db = getDatabase();

  let sql = 'SELECT * FROM projects WHERE deleted_at IS NULL';
  const params = [];

  if (status && status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }

  if (category && category !== 'all') {
    sql += ' AND category = ?';
    params.push(category);
  }

  if (keyword && keyword.trim()) {
    sql += ' AND (title LIKE ? OR overview LIKE ? OR public_summary LIKE ?)';
    const term = `%${keyword.trim()}%`;
    params.push(term, term, term);
  }

  sql += ' ORDER BY updated_at DESC';

  const projects = db.prepare(sql).all(...params);

  // Attach phase summaries and file counts
  const enriched = projects.map(p => {
    const fileCount = db.prepare('SELECT COUNT(*) as count FROM project_files WHERE project_id = ?').get(p.id).count;
    const phaseList = db.prepare('SELECT phase_name, amount_min, amount_max, currency, allow_cs_quote FROM project_phases WHERE project_id = ? ORDER BY order_index ASC').all(p.id);
    return {
      ...p,
      fileCount,
      phases: phaseList
    };
  });

  return res.json({ projects: enriched });
});

/**
 * Create a new archive project
 */
projectRouter.post('/', (req, res) => {
  const { title = '新归档项目', category = 'AI Agent定制' } = req.body || {};
  if(typeof title!=='string'||!title.trim()||title.length>2000||typeof category!=='string'||category.length>2000)return res.status(400).json({error:'invalid_params',message:'项目名称或类别格式错误'});
  const db = getDatabase();
  const id = `proj_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO projects (
      id, title, category, scenario, problem, overview, inputs, outputs, 
      integrations, deployment, deliverables, exclusions, creator_id, 
      status, draft_version, public_title, public_summary, created_at, updated_at
    ) VALUES (?, ?, ?, '', '', '', '', '', '', '', '', '', ?, 'draft', 1, ?, '', ?, ?)
  `).run(id, title.trim(), category.trim(), req.user.id, title.trim(), now, now);

  // Add initial audit log
  const auditId = `audit_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO audit_logs (id, user_id, action, target_type, target_id, details_json, created_at)
    VALUES (?, ?, 'create_project', 'project', ?, '{}', ?)
  `).run(auditId, req.user.id, id, now);

  return res.json({
    success: true,
    project: { id, title: title.trim(), category: category.trim(), status: 'draft' }
  });
});

/**
 * Get project details
 */
projectRouter.get('/:id', (req, res) => {
  const projectId = req.params.id;
  const db = getDatabase();

  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId);
  if (!project) {
    return res.status(404).json({ error: 'not_found', message: '项目不存在或已被删除' });
  }

  const files = db.prepare('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at ASC').all(projectId);
  const phases = db.prepare('SELECT * FROM project_phases WHERE project_id = ? ORDER BY order_index ASC').all(projectId);
  const features = db.prepare('SELECT * FROM project_features WHERE project_id = ? ORDER BY order_index ASC').all(projectId);
  const styles = db.prepare('SELECT * FROM style_references WHERE project_id = ? ORDER BY created_at ASC').all(projectId);
  const chat = db.prepare('SELECT * FROM project_chat WHERE project_id = ? ORDER BY created_at ASC').all(projectId);
  const reviews = db.prepare('SELECT * FROM project_reviews WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  const tasks = TaskQueue.getProjectTasks(projectId);

  return res.json({
    project,
    files,
    phases,
    features: features.map(f => f.feature_text),
    styles,
    chat,
    reviews,
    tasks
  });
});

/**
 * Upload files to project and automatically trigger extraction
 */
projectRouter.post('/:id/files', requireProjectEditor, uploadFiles, async (req, res, next) => {
  let fileTasks = [];
  try {
  const projectId = req.params.id;
  const db = getDatabase();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId);
  if (!project) throw Object.assign(new Error('项目不存在'), {status:404});

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'no_files', message: '未选择任何上传文件' });
  }

  const uploadedRecords = [];
  writableProject(projectId, req.user.id);
  requireIdleProject(projectId);
  transaction(() => {
  invalidateDraft(projectId);
  fileTasks = req.files.map(f => {
    const fileId = `file_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const nameBuffer=Buffer.from(f.originalname,'latin1');
    const decoded=nameBuffer.toString('utf8');
    const originalName=decoded.includes('\uFFFD')?f.originalname:decoded;
    db.prepare("INSERT INTO project_files(id,project_id,original_name,stored_filename,mime_type,size_bytes,sha256,parse_status,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,datetime('now'))").run(fileId,projectId,originalName,f.filename,f.mimetype||'',f.size,crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex'),req.user.id);
    const parseTask = TaskQueue.createTask(projectId, 'file_parse');
    return {f,fileId,originalName,parseTask};
  });
  });
  for (const {f,fileId,originalName,parseTask} of fileTasks) {
    TaskQueue.startTask(parseTask.id);
    const parseResult = await extractDocumentText(f.path, originalName, f.mimetype);
    writableProject(projectId, req.user.id);
    if (parseResult.parse_status === 'failed') TaskQueue.failTask(parseTask.id, parseResult.parse_error_reason);
    else TaskQueue.completeTask(parseTask.id);

    db.prepare('UPDATE project_files SET parse_status=?,extracted_text=?,parse_error_reason=? WHERE id=?').run(parseResult.parse_status,parseResult.extracted_text,parseResult.parse_error_reason,fileId);

    uploadedRecords.push({
      id: fileId,
      original_name: originalName,
      size_bytes: parseResult.sizeBytes,
      parse_status: parseResult.parse_status,
      parse_error_reason: parseResult.parse_error_reason
    });
  }

  // Update project updated_at
  invalidateDraft(projectId);

  return res.json({
    success: true,
    files: uploadedRecords,
    message: `成功归档 ${uploadedRecords.length} 个文件`
  });
  } catch (err) {
    const db=getDatabase();
    for(const item of fileTasks){
      const task=TaskQueue.getTask(item.parseTask.id);
      if(task&&['pending','running'].includes(task.status))TaskQueue.failTask(task.id,'本次解析中断，原件保留，可重新解析');
      db.prepare("UPDATE project_files SET parse_status='failed',parse_error_reason='本次解析中断，原件保留，可重新解析' WHERE id=? AND parse_status='pending'").run(item.fileId);
    }
    for(const file of req.files||[])if(!db.prepare('SELECT 1 FROM project_files WHERE stored_filename=?').get(file.filename))fs.rmSync(file.path,{force:true});
    next(err);
  }
});

/**
 * Securely download an uploaded file attachment
 */
projectRouter.get('/:id/files/:fileId/download', (req, res) => {
  const { id: projectId, fileId } = req.params;
  const db = getDatabase();

  const file = db.prepare('SELECT * FROM project_files WHERE id = ? AND project_id = ?').get(fileId, projectId);
  if (!file) {
    return res.status(404).json({ error: 'file_not_found', message: '附件不存在' });
  }

  const filePath = path.join(CONFIG.UPLOAD_DIR, file.stored_filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'file_missing', message: '服务器物理文件不存在' });
  }

  // Enforce secure download headers: prevent in-browser execution of HTML/SVG/scripts
  const encodedName = encodeURIComponent(file.original_name);
  res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(filePath);
  stream.on('error',()=>{if(!res.headersSent)res.status(404).json({error:'file_missing',message:'附件暂不可读取'});else res.destroy();});
  stream.pipe(res);
});

/**
 * Delete a file attachment from an unapproved project
 */
projectRouter.delete('/:id/files/:fileId', requireProjectEditor, (req, res) => {
  const { id: projectId, fileId } = req.params;
  const db = getDatabase();

  const project = db.prepare('SELECT status, creator_id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'not_found', message: '项目不存在' });

  if (project.status === 'approved' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', message: '已发布的正式案例附件不可直接删除，需先撤回' });
  }

  const file = db.prepare('SELECT * FROM project_files WHERE id = ? AND project_id = ?').get(fileId, projectId);
  if (!file) return res.status(404).json({ error: 'not_found', message: '附件不存在' });

  requireIdleProject(projectId);
  const cleanupPending = withStagedFiles([file.stored_filename],()=>transaction(()=>{
    db.prepare('DELETE FROM project_files WHERE id=?').run(fileId);
    db.prepare("UPDATE project_phases SET source_file_id=NULL,source_type='staff_supplement',allow_cs_quote=0,source_location=? WHERE project_id=? AND source_file_id=?").run('原始来源已删除，请重新核对',projectId,fileId);
    db.prepare('DELETE FROM style_references WHERE project_id=? AND source_file_id=?').run(projectId,fileId);
    invalidateDraft(projectId);
  }));
  return res.json({success:true,cleanupPending,message:cleanupPending?'附件已移出项目，但原件清理未完成，请管理员处理':'附件已删除'});
});

/**
 * Direct manual update of draft
 */
projectRouter.put('/:id/draft', requireProjectEditor, (req, res) => {
  const projectId = req.params.id;
  try {
    const result = OrganizerService.directUpdateDraft(projectId, req.user.id, req.body || {});
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || 'update_failed', message: err.message });
  }
});
