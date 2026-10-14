import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure storage directories exist
if (!fs.existsSync(CONFIG.DATA_DIR)) {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
}
if (!fs.existsSync(CONFIG.UPLOAD_DIR)) {
  fs.mkdirSync(CONFIG.UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(CONFIG.BACKUP_DIR)) {
  fs.mkdirSync(CONFIG.BACKUP_DIR, { recursive: true });
}

export let db = null;

export function initDatabase(dbPath = CONFIG.DB_PATH, { recoverTasks = false } = {}) {
  if (db) return db;

  const isMemory = dbPath === ':memory:';
  if (!isMemory) {
    const parentDir = path.dirname(dbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  db = new DatabaseSync(dbPath);

  // WAL mode for persistent db
  if (!isMemory) {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  // Run schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

  // Restart recovery: mark running/pending tasks as interrupted
  if (recoverTasks) try {
    const updateStmt = db.prepare(`
      UPDATE tasks 
      SET status = 'interrupted', 
          error_message = '服务重启，任务已中断，可点击重新触发',
          updated_at = datetime('now')
      WHERE status IN ('pending', 'running')
    `);
    updateStmt.run();
    db.prepare("UPDATE project_files SET parse_status='failed',parse_error_reason='服务重启，解析中断；原件已保留，请重新解析' WHERE parse_status='pending'").run();
  } catch (err) {
    console.error('Task recovery check error:', err.message);
  }

  return db;
}

export function closeDatabase() { if (db) { db.close(); db = null; } }

export function getDatabase() {
  if (!db) {
    return initDatabase();
  }
  return db;
}

export function transaction(fn) {
  const database = getDatabase();
  database.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    const result = fn();
    database.exec('COMMIT;');
    return result;
  } catch (err) {
    database.exec('ROLLBACK;');
    throw err;
  }
}
