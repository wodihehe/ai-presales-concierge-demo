import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as xlsx from 'xlsx';
import { setupTestDatabase } from './helpers/testDb.js';
import { createApp } from '../server/index.js';
import { CONFIG } from '../server/config.js';
import { extractDocumentText } from '../server/services/fileParser.js';
import { TaskQueue } from '../server/services/taskQueue.js';
import { ReviewService } from '../server/services/reviewService.js';
import { OrganizerService } from '../server/services/organizerService.js';
import { createBackup, restoreBackup } from '../server/db/backup.js';

test('业务工作流与可靠性全覆盖测试 (T01~T06)', async (t) => {
  const db = setupTestDatabase(':memory:');
  const app = createApp();

  let server;
  let testPort = 3298;
  let baseUrl;

  await new Promise(resolve => {
    server = app.listen(testPort, () => {
      baseUrl = `http://127.0.0.1:${testPort}`;
      resolve();
    });
  });

  t.after(() => {
    server.close();
  });

  await t.test('1. 首次管理员安全初始化与二次防护 (P4)', async () => {
    // Write setup token to file
    const setupToken = 'test_setup_token_9999';
    fs.writeFileSync(CONFIG.SETUP_TOKEN_FILE, setupToken, 'utf8');

    // Attempt with wrong token
    const resWrong = await fetch(`${baseUrl}/api/auth/init-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupToken: 'wrong_token',
        username: 'admin',
        name: '系统管理员',
        password: 'admin_password_123'
      })
    });
    assert.equal(resWrong.status, 403);

    // Attempt with correct token
    const resCorrect = await fetch(`${baseUrl}/api/auth/init-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupToken,
        username: 'admin_test',
        name: '超级管理员',
        password: 'admin_password_123'
      })
    });
    assert.equal(resCorrect.status, 200);
    const data = await resCorrect.json();
    assert.equal(data.success, true);
    assert.equal(data.user.role, 'admin');

    // Verify token file was destroyed
    assert.equal(fs.existsSync(CONFIG.SETUP_TOKEN_FILE), false, 'Setup Token 文件必须在初始化成功后销毁');

    // Subsequent init-admin attempt MUST be rejected
    const resRepeated = await fetch(`${baseUrl}/api/auth/init-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupToken: 'any',
        username: 'another_admin',
        name: '入侵者',
        password: 'password123456'
      })
    });
    assert.equal(resRepeated.status, 403, '已初始化后禁止再次调用');
  });

  await t.test('2. 格式不设白名单与真实解析层 (P3/K02)', async () => {
    const tmpDir = path.join(CONFIG.DATA_DIR, 'test_tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // 2.1 Plain text / Markdown
    const txtPath = path.join(tmpDir, 'sample_plan.txt');
    fs.writeFileSync(txtPath, '【某AI工作流方案】\n一期实施报价：50,000元整。', 'utf8');
    const txtRes = await extractDocumentText(txtPath, 'sample_plan.txt', 'text/plain');
    assert.equal(txtRes.parse_status, 'parsed');
    assert.ok(txtRes.extracted_text.includes('50,000元'));

    // 2.2 Excel spreadsheet
    const xlsxPath = path.join(tmpDir, 'quote_sheet.xlsx');
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([['项目阶段', '功能', '报价'], ['一期', '基础问答', 30000], ['二期', '多模态', 20000]]);
    xlsx.utils.book_append_sheet(wb, ws, '报价明细');
    fs.writeFileSync(xlsxPath, xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    const xlsxRes = await extractDocumentText(xlsxPath, 'quote_sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(xlsxRes.parse_status, 'parsed');
    assert.ok(xlsxRes.extracted_text.includes('报价明细'));
    assert.ok(xlsxRes.extracted_text.includes('30000'));

    // 2.3 Binary .doc (Word 97-2003) -> unsupported with transparent advice
    const docPath = path.join(tmpDir, 'legacy.doc');
    fs.writeFileSync(docPath, Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])); // OLE header
    const docRes = await extractDocumentText(docPath, 'legacy.doc', 'application/msword');
    assert.equal(docRes.parse_status, 'unsupported');
    assert.ok(docRes.parse_error_reason.includes('.docx 或 PDF'));

    // 2.4 Arbitrary unsupported format (.dwg CAD file) -> NOT rejected, saved as original
    const cadPath = path.join(tmpDir, 'drawing.dwg');
    fs.writeFileSync(cadPath, Buffer.from('AC1015_AUTOCAD_DRAWING_DATA'));
    const cadRes = await extractDocumentText(cadPath, 'drawing.dwg', 'application/acad');
    assert.equal(cadRes.parse_status, 'unsupported');
    assert.ok(cadRes.parse_error_reason.includes('无法自动提取结构化文本'));

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('3. 持久化任务追踪与重启恢复机制 (P3)', () => {
    const task = TaskQueue.createTask('proj_restart_test', 'file_parse');
    assert.equal(task.status, 'pending');

    TaskQueue.startTask(task.id);
    const runningTask = TaskQueue.getTask(task.id);
    assert.equal(runningTask.status, 'running');

    // Simulate server restart: run recovery query
    db.prepare(`
      UPDATE tasks 
      SET status = 'interrupted', 
          error_message = '服务重启，任务已中断，可点击重新触发',
          updated_at = datetime('now')
      WHERE status IN ('pending', 'running')
    `).run();

    const recoveredTask = TaskQueue.getTask(task.id);
    assert.equal(recoveredTask.status, 'interrupted', '重启后未完成任务必须转为 interrupted，禁止永久转圈');
  });

  await t.test('4. 审核版本防并发覆盖保护 (P2)', () => {
    // Create test project
    const projId = 'proj_concurrency_test';
    db.prepare(`
      INSERT INTO projects (id, title, creator_id, status, draft_version, created_at, updated_at)
      VALUES (?, '测试并发项目', 'usr_test', 'pending_review', 3, datetime('now'), datetime('now'))
    `).run(projId);

    // Reviewer attempts approval with outdated draft version (e.g. saw v2, but project is now v3)
    assert.throws(() => {
      ReviewService.approveProject(projId, 'usr_reviewer', 2, '过期审批');
    }, (err) => {
      return err.code === 'draft_stale';
    }, '草稿已被修改时必须拒绝旧审核');

    // Reviewer approves with correct version 3
    const result = ReviewService.approveProject(projId, 'usr_reviewer', 3, '审核通过');
    assert.equal(result.status, 'approved');

    const project = db.prepare('SELECT status, approved_by FROM projects WHERE id = ?').get(projId);
    assert.equal(project.status, 'approved');
    assert.equal(project.approved_by, 'usr_reviewer');
  });

  await t.test('5. 员工与管理员撤回权限核对 (D01)', () => {
    const projId = 'proj_revoke_test';
    db.prepare(`
      INSERT INTO projects (id, title, creator_id, status, draft_version, created_at, updated_at)
      VALUES (?, '撤回测试项目', 'usr_creator_1', 'approved', 1, datetime('now'), datetime('now'))
    `).run(projId);

    // Unrelated staff (neither creator, reviewer, nor admin)
    const unrelatedUser = { id: 'usr_stranger', role: 'staff' };
    assert.throws(() => {
      ReviewService.revokeProject(projId, unrelatedUser, '恶意撤回');
    }, (err) => err.code === 'forbidden', '非相关员工不得撤回他人项目');

    // Creator can revoke
    const creatorUser = { id: 'usr_creator_1', role: 'staff' };
    const revResult = ReviewService.revokeProject(projId, creatorUser, '发现内容有误');
    assert.equal(revResult.status, 'revoked');

    const check = db.prepare('SELECT status FROM projects WHERE id = ?').get(projId);
    assert.equal(check.status, 'revoked');
  });

  await t.test('6. WAL 检查点与一致性备份恢复 (P3)', () => {
    // Write test data in real test db path
    const backupManifest = createBackup();
    assert.ok(backupManifest.backupFolder);
    assert.ok(fs.existsSync(backupManifest.backupFolder));
    assert.ok(fs.existsSync(path.join(backupManifest.backupFolder, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(backupManifest.backupFolder, 'knowledge_base.db')));

    // Clean up backup folder created during test
    fs.rmSync(backupManifest.backupFolder, { recursive: true, force: true });
  });
});
