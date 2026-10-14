import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SKILL_FILE = new URL('../skills/customer-service/SKILL.md', import.meta.url);
const KNOWLEDGE_SKILL_FILE = new URL('../skills/knowledge-reply/SKILL.md', import.meta.url);
const MAX_SKILL_BYTES = 64 * 1024;

// A fixed, project-owned file is read once per intake call, never from a visitor
// path or attachment. The optional path is for isolated loader tests only.
export function loadCustomerServiceSkill(file = SKILL_FILE) {
  return loadSkill(file, 'customer-service');
}

export function loadKnowledgeReplySkill() {
  return loadSkill(KNOWLEDGE_SKILL_FILE, 'knowledge-reply');
}

function loadSkill(file, expectedId) {
  const bytes = readFileSync(file);
  if (!bytes.length || bytes.length > MAX_SKILL_BYTES) throw new Error('invalid_customer_service_skill');
  const content = bytes.toString('utf8').replace(/^\uFEFF/u, '');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  const header = frontmatter?.[1];
  const id = /^name:\s*([a-z][a-z0-9-]*)\s*$/mu.exec(header || '')?.[1];
  const metadata = /^metadata:[ \t]*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))+)/mu.exec(header || '')?.[1];
  const version = /^[ \t]+version:[ \t]*(\d+\.\d+\.\d+)[ \t]*$/mu.exec(metadata || '')?.[1];
  if (id !== expectedId || !version || !content.slice(frontmatter?.[0].length || content.length).trim()) {
    throw new Error('invalid_customer_service_skill');
  }
  return { content, id, version, sha256: createHash('sha256').update(bytes).digest('hex') };
}
