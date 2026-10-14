import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initDatabase, closeDatabase } from '../server/db/index.js';
import { createApp } from '../server/index.js';
import { createSessionToken } from '../server/middleware/auth.js';
import { listUpstreamModels, modelsEndpoint } from '../server/services/modelCatalog.js';
import { startMockCatalog } from './helpers/mockCatalog.js';

test('模型列表 [SYNTHETIC_FIXTURE]', async t => {
  const db = initDatabase(':memory:');
  const mock = await startMockCatalog();
  const app = createApp().listen(0, '127.0.0.1');
  await new Promise(r => app.once('listening', r));
  t.after(async () => { app.closeAllConnections(); await new Promise(r=>app.close(r)); await mock.close(); closeDatabase(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const key = crypto.randomBytes(24).toString('hex');
  const tokens = {};
  for (const role of ['admin','staff']) {
    db.prepare("INSERT INTO users VALUES(?,?,'','',?,?,0,1,datetime('now'),datetime('now'))").run(role, role, role, role);
    tokens[role] = createSessionToken({id:role, username:role, role, token_version:1});
  }
  const set = (k,v) => db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?,datetime('now'))").run(k,v);
  set('model_base_url',mock.url+'/v1'); set('model_api_key',key); set('model_name','existing-model');
  const snapshot = () => db.prepare('SELECT * FROM settings ORDER BY key').all();
  async function post(body={}, role='admin') {
    const response = await fetch(base+'/api/settings/models',{method:'POST',headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${tokens[role]}`}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  await t.test('管理员权限在请求上游前校验', async () => {
    assert.equal((await post({},null)).status,401);
    assert.equal((await post({},'staff')).status,403);
    assert.equal(mock.requests.length,0);
  });
  await t.test('未保存输入可取列表、不需模型名、只返回去重ID且不修改配置', async () => {
    const before=snapshot();
    const newKey=crypto.randomBytes(24).toString('hex');
    const result=await post({model_base_url:mock.url,model_api_key:newKey});
    assert.equal(result.status,200); assert.equal(result.data.success,true);
    assert.equal(result.data.models.length,4); assert.equal(result.data.skippedCount,3);
    assert.equal(mock.requests.at(-1).path,'/v1/models'); assert.equal(mock.requests.at(-1).method,'GET');
    assert.equal(mock.requests.at(-1).authorization,`Bearer ${newKey}`);
    assert.ok(!JSON.stringify(result).includes(newKey));
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_METADATA'));
    assert.deepEqual(snapshot(),before);
  });
  await t.test('同一地址留空复用密钥、基础路径与完整聊天地址等价', async () => {
    for (const suffix of ['', '/v1/', '/v1/chat/completions/']) {
      assert.equal((await post({model_base_url:mock.url+suffix,model_api_key:''})).status,200);
      assert.equal(mock.requests.at(-1).authorization,`Bearer ${key}`);
    }
    assert.equal(modelsEndpoint(mock.url+'/gateway/v1/'),mock.url+'/gateway/v1/models');
  });
  await t.test('改地址不发送已保存密钥，非法参数在网络前拒绝', async () => {
    const count=mock.requests.length;
    for (const body of [
      {model_base_url:mock.url+'/another'}, {model_base_url:''},
      {model_base_url:42}, {model_api_key:{}}, [],
      {model_base_url:'ftp://example.invalid'}, {model_base_url:mock.url+'?key=secret'},
      {model_base_url:'http://user:password@example.invalid'}, {model_api_key:'bad\nkey'}
    ]) assert.equal((await post(body)).status,400);
    assert.equal(mock.requests.length,count);
    set('model_api_key',''); assert.equal((await post()).status,400); set('model_api_key',key);
  });
  await t.test('空列表与上游错误明确区分，错误不回显密钥', async () => {
    mock.setMode('empty'); assert.deepEqual((await post()).data.models,[]);
    for (const [mode,reason] of [['http401','upstream_auth'],['http403','upstream_auth'],['http404','unsupported'],['http405','unsupported'],['http429','rate_limited'],['http500','upstream_error'],['invalid','invalid_response'],['shape','invalid_response'],['large','response_too_large'],['many','too_many_models']]) {
      mock.setMode(mode); const result=await post();
      assert.equal(result.status,502); assert.equal(result.data.reason,reason);
      assert.ok(!JSON.stringify(result).includes(key));
    }
  });
  await t.test('正文读取同样超时，禁止携带凭证跟随重定向', async () => {
    mock.setMode('slow'); const start=Date.now();
    const result=await listUpstreamModels({baseUrl:mock.url,apiKey:key},{timeoutMs:100});
    assert.equal(result.reason,'timeout'); assert.ok(Date.now()-start<2000);
    mock.setMode('redirect'); const count=mock.requests.length;
    assert.equal((await post()).data.reason,'network_error');
    assert.equal(mock.requests.length,count+1);
  });
});
