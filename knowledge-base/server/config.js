import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const subprojectRoot = path.resolve(__dirname, '..');
const dataDir = path.resolve(subprojectRoot, process.env.KB_DATA_DIR || (process.env.NODE_TEST_CONTEXT ? `tests/.tmp/run-${process.pid}` : 'data'));
const relativeData = path.relative(subprojectRoot, dataDir);
if (!relativeData || relativeData.startsWith('..') || path.isAbsolute(relativeData)) {
  throw new Error('KB_DATA_DIR 必须位于知识库目录内部的独立子目录');
}

export const CONFIG = {
  PORT: Number.parseInt(process.env.PORT, 10) || 3220,
  ROOT_DIR: subprojectRoot,
  DATA_DIR: dataDir,
  DB_PATH: path.join(dataDir, 'knowledge_base.db'),
  UPLOAD_DIR: path.join(dataDir, 'uploads'),
  BACKUP_DIR: path.join(dataDir, 'backups'),
  SETUP_TOKEN_FILE: path.join(dataDir, '.setup_token'),
  
  // Resource & security limits
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024, // 50MB
  MAX_EXTRACT_CHARS: 200_000,           // 20万字符限制，截断时透明提示
  PARSE_TIMEOUT_MS: 30_000,             // 单文件解析30秒超时保护
  REQUEST_TIMEOUT_MS: 30_000,
  
  // Session & Security
  SESSION_COOKIE_NAME: 'kb_session',
  TOKEN_TTL_MS: 7 * 24 * 60 * 60 * 1000 // 7天
};
