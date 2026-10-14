import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { root, runtime, csData, kbData, kbRelativeData } from './paths.js';

export { root } from './paths.js';
export async function seed() {
  process.env.KB_DATA_DIR = kbRelativeData;
  const { initDatabase, closeDatabase } = await import('../knowledge-base/server/db/index.js');
  const { hashPassword } = await import('../knowledge-base/server/middleware/auth.js');
  const { openStore } = await import('../customer-service/server/store.js');
  mkdirSync(runtime, { recursive: true });
  const credentialFile = path.join(runtime, 'credentials.json');
  const credentials = existsSync(credentialFile) ? JSON.parse(readFileSync(credentialFile))
    : { username: 'demo_admin', password: randomBytes(24).toString('base64url'), integrationKey: randomBytes(32).toString('hex') };
  if (!existsSync(credentialFile)) writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  const db = initDatabase();
  const now = new Date().toISOString();
  const { hash, salt } = hashPassword(credentials.password);
  db.prepare(`INSERT OR IGNORE INTO users(id,username,password_hash,salt,role,name,created_at,updated_at)
    VALUES('demo_admin',?,?,?,'admin','演示管理员',?,?)`).run(credentials.username, hash, salt, now, now);
  db.prepare("INSERT OR REPLACE INTO settings VALUES('bootstrap_complete','true',?)").run(now);
  db.prepare("INSERT OR REPLACE INTO settings VALUES('integration_api_key',?,?)").run(credentials.integrationKey, now);
  const cases = JSON.parse(readFileSync(path.join(root, 'examples/cases.json')));
  // Only the first launch inserts fictional fixtures; subsequent launches retain edits/reviews/deletions.
  if (!db.prepare("SELECT 1 FROM settings WHERE key='demo_seeded'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of cases) {
        const source = `# ${c.title}\n\n资料性质：完全虚构，仅用于流程演示，不是公司交付记录或真实报价。\n\n场景：${c.scenario}\n输入：${c.inputs}\n输出：${c.outputs}\n对接：${c.integrations}\n功能：${c.features.join('；')}\n方案：${c.summary}\n\n${c.min ? `演示价格：${c.min}—${c.max} CNY；关系：独立范围；不构成商业报价。` : '没有价格资料。'}\n`;
        const fileId = `${c.id}-source`, filename = `${fileId}.md`;
        writeFileSync(path.join(kbData, 'uploads', filename), source);
        db.prepare(`INSERT INTO projects(id,title,category,scenario,overview,inputs,outputs,integrations,deliverables,creator_id,status,public_title,public_summary,approved_by,approved_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'demo_admin',?,?,?,?,?,?,?)`).run(c.id,c.title,c.category,c.scenario,c.summary,c.inputs,c.outputs,c.integrations,c.features.join('；'),c.draft?'draft':'approved',c.title,c.summary,c.draft?null:'demo_admin',c.draft?null:now,now,now);
        db.prepare(`INSERT INTO project_files(id,project_id,original_name,stored_filename,mime_type,size_bytes,sha256,parse_status,extracted_text,uploaded_by,created_at)
          VALUES(?,?,?,?,'text/markdown',?,?,'parsed',?,'demo_admin',?)`).run(fileId,c.id,filename,filename,Buffer.byteLength(source),createHash('sha256').update(source).digest('hex'),source,now);
        c.features.forEach((f,i)=>db.prepare('INSERT INTO project_features(id,project_id,feature_text,is_public,order_index) VALUES(?,?,?,1,?)').run(`${c.id}-f${i}`,c.id,f,i));
        if (c.min) db.prepare(`INSERT INTO project_phases(id,project_id,phase_name,scope_description,relation,amount_min,amount_max,currency,raw_amount_text,source_file_id,source_location,allow_cs_quote)
          VALUES(?,?,'演示范围',?,'standalone',?,?,'CNY',?,?,'演示原件价格段',1)`).run(`${c.id}-price`,c.id,c.features.join('；'),c.min,c.max,`演示价格 ${c.min}—${c.max} CNY`,fileId);
        db.prepare('INSERT INTO style_references(id,project_id,topic,desensitized_example,source_file_id,created_at) VALUES(?,?,?,?,?,?)').run(`${c.id}-style`,c.id,'演示方案组织',c.style,fileId,now);
        if (!c.draft) db.prepare(`INSERT INTO project_reviews(id,project_id,reviewer_id,action,reason,snapshot_json,created_at) VALUES(?,?,'demo_admin','approved','虚构种子演示审核，不代表实际员工验收','{}',?)`).run(`${c.id}-review`,c.id,now);
      }
      db.prepare("INSERT INTO settings VALUES('demo_seeded','true',?)").run(now);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Optional real model settings never enter sources or distributable archives.
  if (process.env.DEMO_MODEL_BASE_URL && process.env.DEMO_MODEL_NAME && process.env.DEMO_MODEL_API_KEY) {
    for (const [key,value] of Object.entries({model_base_url:process.env.DEMO_MODEL_BASE_URL,model_name:process.env.DEMO_MODEL_NAME,model_api_key:process.env.DEMO_MODEL_API_KEY})) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(key,value,now);
  }
  closeDatabase();
  const store = openStore(csData);
  if (!store.users().length) store.createUser(credentials.username,credentials.password,'admin');
  const settings = store.settings();
  settings.companyName = 'AI 项目顾问 · Demo';
  settings.companyDescription = '独立演示环境：案例、方案和价格均为虚构，通知只保存在本机。';
  settings.knowledge = {url:`http://127.0.0.1:${process.env.DEMO_KB_PORT||3320}/api/integrations/customer-service/search`,apiKey:credentials.integrationKey};
  settings.wecom = {webhook:'demo://local-notification'};
  settings.demo = {localNotifications:true};
  if (process.env.DEMO_MODEL_BASE_URL && process.env.DEMO_MODEL_NAME && process.env.DEMO_MODEL_API_KEY) settings.model = {baseUrl:process.env.DEMO_MODEL_BASE_URL,name:process.env.DEMO_MODEL_NAME,apiKey:process.env.DEMO_MODEL_API_KEY};
  store.saveSettings(settings); store.close();
}
