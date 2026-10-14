import { randomBytes, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

export const id = () => randomBytes(24).toString('base64url');
export const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
export function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw Object.assign(new Error('密码请使用 12–200 个字符。'), {status:400});
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || password.length > 200) return false;
    const [salt,value] = stored.split(':');
    return timingSafeEqual(Buffer.from(value,'hex'),scryptSync(password,salt,64));
  } catch { return false; }
}
export function secretBox(dir) {
  const file = path.join(dir,'master.key');
  if (!existsSync(file)) writeFileSync(file,randomBytes(32),{mode:0o600,flag:'wx'});
  try { chmodSync(file,0o600); } catch { /* Windows ACLs managed by OS. */ }
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error('数据密钥长度不正确，请从安全备份恢复。');
  return {
    encrypt(value) {
      const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
      const result=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
      return [iv,cipher.getAuthTag(),result].map(b=>b.toString('base64')).join('.');
    },
    decrypt(value) {
      const [iv,tag,payload]=value.split('.').map(v=>Buffer.from(v,'base64'));
      const decipher=createDecipheriv('aes-256-gcm',key,iv); decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(payload),decipher.final()]).toString('utf8'));
    }
  };
}
export function urlSetting(value, label, {wecom=false}={}) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 2048) throw Object.assign(new Error(`${label}格式不正确。`),{status:400});
  let u; try {u=new URL(value);} catch {throw Object.assign(new Error(`${label}必须是有效网址。`),{status:400});}
  if (!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash) throw Object.assign(new Error(`${label}仅支持无用户信息的 HTTP(S) 地址。`),{status:400});
  if (wecom && (u.protocol!=='https:'||u.hostname!=='qyapi.weixin.qq.com'||u.pathname!=='/cgi-bin/webhook/send'||!u.searchParams.get('key'))) throw Object.assign(new Error('请填写有效的企业微信群机器人 Webhook 地址。'),{status:400});
  return u.toString().replace(/\/$/,'');
}
