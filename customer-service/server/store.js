import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { id, hash, secretBox, passwordHash } from './security.js';
import {localize} from '../../shared/server-locale.js';

export const RETENTION_MS=30*24*60*60*1000;
export const defaults=()=>({companyName:'AI 业务顾问',companyDescription:'',model:{baseUrl:'',name:'',apiKey:''},knowledge:{url:'',apiKey:''},wecom:{webhook:''},qrUrl:null,schedule:{timezone:'Asia/Hong_Kong',days:[],start:'09:00',end:'18:00',holidays:[]},daytimeMessage:'同事会尽快与你联系。',nighttimeMessage:'同事会在下一个人工服务时段联系你。',embedOrigins:[]});
export function openStore(dir,{recoverNotificationHolds=false}={}) {
  mkdirSync(dir,{recursive:true,mode:0o700}); mkdirSync(path.join(dir,'files'),{recursive:true,mode:0o700});
  const box=secretBox(dir), db=new DatabaseSync(path.join(dir,'customer-service.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(owner,created_at);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,next_at INTEGER NOT NULL,UNIQUE(conversation_id,fingerprint));
    CREATE TABLE IF NOT EXISTS notification_holds (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,token TEXT NOT NULL);`);
  // A process interruption leaves a conservatively invalidated conversation.
  // Never resume an old price notification without a completed interpretation.
  if(recoverNotificationHolds)db.exec(`BEGIN IMMEDIATE;
    UPDATE notifications SET status='superseded' WHERE status<>'sent' AND conversation_id IN (SELECT conversation_id FROM notification_holds);
    DELETE FROM notification_holds;
    COMMIT;`);
  const settings=()=>{const row=db.prepare('SELECT value FROM settings WHERE id=1').get(); return row?box.decrypt(row.value):defaults();};
  const saveSettings=(data)=>db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(box.encrypt(data));
  function createConversation(owner) {
    const now=Date.now(), c={id:id(),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+RETENTION_MS).toISOString(),messages:[],profile:{project:'',scenario:'',problem:'',features:[],inputs:'',outputs:'',integrations:'',budget:'',timeline:''},summaryReady:false,summaryConfirmed:false,summaryVersion:0,quote:null,quoteSources:[],knowledgeStatus:'not_configured',feedback:'not_quoted',handoff:false,followupStatus:'pending',contact:null,requestIds:[],notificationReason:''};
    c.messages.push({id:id(),role:'assistant',content:localize('你好呀，欢迎来聊聊你的 AI 项目 👋\n从一个想解决的问题开始就好，我会和你一起把需求理清楚。你希望 AI 帮你做什么呢？'),createdAt:c.createdAt,attachments:[]});
    db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(c.id,owner,JSON.stringify(c),now,now+RETENTION_MS); return c;
  }
  const getConversation=(cid)=>{const row=db.prepare('SELECT data FROM conversations WHERE id=? AND expires_at>?').get(cid,Date.now());return row?JSON.parse(row.data):null;};
  const saveConversation=c=>db.prepare('UPDATE conversations SET data=? WHERE id=? AND expires_at>?').run(JSON.stringify(c),c.id,Date.now());
  const owns=(cid,owner)=>!!db.prepare('SELECT id FROM conversations WHERE id=? AND owner=? AND expires_at>?').get(cid,owner,Date.now());
  const latest=owner=>{const row=db.prepare('SELECT data FROM conversations WHERE owner=? AND expires_at>? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(owner,Date.now()); return row?JSON.parse(row.data):null;};
  const conversations=()=>db.prepare('SELECT data FROM conversations WHERE expires_at>? ORDER BY created_at DESC').all(Date.now()).map(r=>JSON.parse(r.data));
  const attachments=cid=>db.prepare('SELECT data FROM attachments WHERE conversation_id=?').all(cid).map(r=>JSON.parse(r.data));
  const attachment=aid=>{const r=db.prepare('SELECT data FROM attachments WHERE id=?').get(aid);return r?JSON.parse(r.data):null;};
  const saveAttachment=a=>db.prepare('INSERT INTO attachments VALUES(?,?,?)').run(a.id,a.conversationId,JSON.stringify(a));
  const notifications=cid=>db.prepare('SELECT data,status FROM notifications WHERE conversation_id=? ORDER BY rowid DESC').all(cid).map(r=>({...JSON.parse(r.data),status:r.status}));
  const saveNotification=n=>db.prepare("UPDATE notifications SET data=?,status=?,next_at=? WHERE id=? AND status NOT IN ('superseded','sent')").run(JSON.stringify(n),n.status,n.nextAt,n.id);
  function enqueue(cid,fp,payload) {
    const old=db.prepare('SELECT data FROM notifications WHERE conversation_id=? AND fingerprint=?').get(cid,fp);
    if(old){const n={...JSON.parse(old.data),payload,status:'pending',attempts:0,sentParts:0,lastError:'',createdAt:new Date().toISOString(),nextAt:Date.now()};db.prepare('UPDATE notifications SET data=?,status=?,next_at=? WHERE id=?').run(JSON.stringify(n),n.status,n.nextAt,n.id);return n;}
    const n={id:id(),conversationId:cid,fingerprint:fp,payload,status:'pending',attempts:0,lastError:'',createdAt:new Date().toISOString(),nextAt:Date.now()};
    db.prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?,?,?,?)').run(n.id,cid,fp,JSON.stringify(n),n.status,n.nextAt);return n;
  }
  function deleteConversation(cid) {
    for(const a of attachments(cid)) rmSync(path.join(dir,'files',a.id),{force:true});
    db.prepare('DELETE FROM conversations WHERE id=?').run(cid);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  function cleanup(now=Date.now()) {
    const old=db.prepare('SELECT id FROM conversations WHERE expires_at<=?').all(now);
    for(const c of old) deleteConversation(c.id);
    db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now);
    const keep=new Set(db.prepare('SELECT id FROM attachments').all().map(r=>r.id));
    for(const name of readdirSync(path.join(dir,'files'))) if(!keep.has(name)) rmSync(path.join(dir,'files',name),{force:true});
    return old.length;
  }
  const users=()=>db.prepare('SELECT id,username,role,active,created_at AS createdAt FROM users').all().map(u=>({...u,active:!!u.active}));
  function createUser(username,password,role='staff') {
    if(typeof username!=='string'||! /^[\p{L}\p{N}_@.-]{3,64}$/u.test(username)) throw Object.assign(new Error('用户名需为 3–64 位字母、中文、数字或 _@.-。'),{status:400});
    if(!['admin','staff'].includes(role)) throw Object.assign(new Error('无效账号角色。'),{status:400});
    const uid=id(); db.prepare('INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,?,?,?)').run(uid,username,passwordHash(password),role,new Date().toISOString());return users().find(u=>u.id===uid);
  }
  const sessionUser=token=>{if(!token)return null;return db.prepare('SELECT u.id,u.username,u.role FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1').get(hash(token),Date.now())||null;};
  return {db,dir,settings,saveSettings,createConversation,getConversation,saveConversation,owns,latest,conversations,attachments,attachment,saveAttachment,notifications,saveNotification,enqueue,deleteConversation,cleanup,users,createUser,sessionUser,close:()=>db.close()};
}
