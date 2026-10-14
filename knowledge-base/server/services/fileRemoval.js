import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';

// Move first so a failed database transaction can restore every original.
// A post-commit cleanup failure is explicit and leaves a recoverable directory.
export function withStagedFiles(names, commit) {
  const folder = path.join(CONFIG.DATA_DIR, 'deletion-pending', crypto.randomUUID());
  const moved = [];
  fs.mkdirSync(folder, { recursive: true });
  try {
    for (const name of names) {
      if (path.basename(name) !== name || /[\\/:]/.test(name)) throw new Error('附件存储路径不合法');
      const original = path.join(CONFIG.UPLOAD_DIR, name);
      if (fs.existsSync(original)) {
        fs.renameSync(original, path.join(folder, name));
        moved.push(name);
      }
    }
    commit();
  } catch (err) {
    for (const name of moved.reverse()) fs.renameSync(path.join(folder, name), path.join(CONFIG.UPLOAD_DIR, name));
    fs.rmSync(folder, { recursive: true, force: true });
    throw err;
  }
  try { fs.rmSync(folder, { recursive: true, force: true }); return false; }
  catch { return true; }
}
