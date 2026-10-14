import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '../customer-service/node_modules/playwright-core/index.mjs';
import { runtime } from './test-runtime.js';
import { root } from './paths.js';
const env=await runtime({csPort:3518,kbPort:3520});
const artifacts=path.join(root,'artifacts/browser');mkdirSync(artifacts,{recursive:true});
let browser;
try{
  browser=await chromium.launch({channel:process.env.DEMO_BROWSER||'msedge',headless:true});
  const page=await browser.newPage({locale:'zh-CN',viewport:{width:1440,height:1000}}),errors=[],checks=[],layouts=[];
  page.on('pageerror',e=>errors.push(e.message));
  const waitMessage=async action=>{const waiting=page.waitForResponse(r=>r.url().includes('/messages')&&r.request().method()==='POST');await action();assert.equal((await waiting).status(),200);};
  const send=async text=>{await page.getByRole('textbox',{name:'项目需求消息'}).fill(text);await waitMessage(()=>page.getByRole('button',{name:'发送消息',exact:true}).click());};
  const capture=async(name)=>{
    for(const width of [390,1024,1440]){
      await page.setViewportSize({width,height:1000});
      if(name.startsWith('customer-'))await page.locator('.chat-thread').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      await page.screenshot({path:path.join(artifacts,`${name}-${width}.png`),fullPage:true});
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
      assert.equal(overflow,0,`${name} ${width} 横向溢出`);layouts.push({name,width,overflow});
    }
  };
  await page.goto(env.cs);await page.getByRole('button',{name:'商品图',exact:true}).click();
  await waitMessage(()=>page.getByRole('button',{name:'发送消息',exact:true}).click());
  await page.getByRole('button',{name:'需求基本符合',exact:true}).waitFor();checks.push('样例填入和待客户确认');await capture('customer-ready');
  await page.getByRole('button',{name:'需求基本符合',exact:true}).click();
  await page.getByText('8,000').first().waitFor();await page.getByText('【离线检索演示 · 虚构方案】',{exact:false}).waitFor();checks.push('确认与方案价格展示');
  await send('接受');await send('同意联系我，邮箱 visitor@example.test');
  await page.getByText('本地演示通知正在处理',{exact:false}).waitFor();checks.push('聊天留资回执');await capture('customer-quoted');
  await page.reload();await page.getByText('你的项目信息已登记',{exact:true}).waitFor();checks.push('刷新续接');
  assert.equal((await page.goto(`${env.cs}/demo/login?inbox=1`)).status(),200);await page.locator('#items pre').filter({hasText:'visitor@example.test'}).waitFor();await capture('inbox');checks.push('本地收件箱简报');
  await page.goto(`${env.cs}/demo/login`);await page.getByRole('button',{name:'项目咨询',exact:true}).waitFor();await capture('admin');checks.push('后台登录与咨询可见');
  await page.goto(env.cs);await page.getByRole('button',{name:'新建对话',exact:true}).click();await page.getByRole('button',{name:'确认新建',exact:true}).click();
  await page.getByRole('button',{name:'内网问答',exact:true}).click();await waitMessage(()=>page.getByRole('button',{name:'发送消息',exact:true}).click());
  await page.getByRole('button',{name:'需求基本符合',exact:true}).click();await page.getByText('缺少价格依据',{exact:true}).waitFor();checks.push('新对话与同类无价');
  await page.goto(`${env.kb}/demo/login`);await page.locator('#projectsList').getByText('未审核测试档案（虚构演示）',{exact:true}).waitFor();await capture('knowledge-list');checks.push('知识库登录与四个档案');
  const draftRow=page.locator('#projectsList > div').filter({hasText:'未审核测试档案'});
  await draftRow.click();await page.locator('#draftTitle').waitFor();
  await page.locator('#draftPublicSummary').fill('虚构审核演示：商品照片经过内容生成与人工复核后导出。');
  page.on('dialog',d=>d.accept());
  const saved=page.waitForResponse(r=>r.url().endsWith('/draft')&&r.request().method()==='PUT');
  await page.getByRole('button',{name:'保存草稿变更',exact:true}).click();assert.equal((await saved).status(),200);
  await page.getByRole('button',{name:'提交审核',exact:true}).click();await page.getByRole('button',{name:'审核通过入库',exact:true}).waitFor();
  await page.getByRole('button',{name:'审核通过入库',exact:true}).click();
  await page.locator('#reviewConfirmBtn').click();
  await page.locator('#wsProjectStatusBadge').filter({hasText:'已发布'}).waitFor();checks.push('知识库编辑保存提交审核发布');await capture('knowledge-detail');
  assert.equal(errors.length,0);
  writeFileSync(path.join(root,'artifacts/browser.json'),JSON.stringify({date:new Date().toISOString(),checks,layouts,errors,mode:'offline',realModelCalls:0,realWecomCalls:0},null,2));
  console.log(JSON.stringify({checks:checks.length,layouts:layouts.length,errors:errors.length}));
}finally{if(browser)await browser.close();await env.stop();}
