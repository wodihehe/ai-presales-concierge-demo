import {chromium} from '../customer-service/node_modules/playwright-core/index.mjs';
import {runtime} from './test-runtime.js';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {root} from './paths.js';
const env=await runtime({csPort:3718,kbPort:3720});
const folder=path.join(root,'artifacts/language');mkdirSync(folder,{recursive:true});
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'en-US',viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],checks=[],layouts=[],untranslated=[];
  page.on('pageerror',e=>errors.push(e.message));
  const capture=async name=>{
    for(const width of [390,1024,1440]){
      await page.setViewportSize({width,height:1000});await page.screenshot({path:path.join(folder,`${name}-${width}.png`),fullPage:true});
      const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,untranslated:[...document.querySelectorAll('body *')].filter(el=>el.getClientRects().length&&!el.closest('.messages,textarea,input,#wsSourceDetails,#wsChatMessages,[data-original],pre,code,script,style')&&el.childElementCount===0&&/[\u3400-\u9fff]/.test(el.textContent)&&!/^中文$/.test(el.textContent.trim())).map(el=>el.textContent.trim())}));
      assert.equal(result.overflow,0,`${name}:${width}`);layouts.push({name,width,overflow:result.overflow});untranslated.push(...result.untranslated);
    }
  };
  await page.goto(env.cs);await page.getByRole('button',{name:'Product images',exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'en');checks.push('浏览器首次英文');await capture('en-chat');
  const send=async text=>{if(text)await page.getByRole('textbox',{name:'Project message'}).fill(text);const wait=page.waitForResponse(r=>r.url().includes('/messages')&&r.request().method()==='POST');await page.getByRole('button',{name:'Send message',exact:true}).click();assert.equal((await wait).status(),200);};
  await page.getByRole('button',{name:'Product images',exact:true}).click();await send();await page.getByRole('button',{name:'Confirm requirements',exact:true}).click();await page.getByText('Fictional demo price',{exact:false}).waitFor();await page.getByText('[Offline retrieval demo · Fictional proposal]',{exact:false}).waitFor();
  await send('Accept');await send('I agree to project follow-up, email visitor@example.test');checks.push('英文示例确认报价留资');await page.locator('.chat-thread').evaluate(el=>el.scrollTop=el.scrollHeight);await capture('en-quote');
  await page.getByRole('button',{name:'Contact a consultant',exact:true}).first().click();await page.getByRole('dialog').waitFor();await capture('en-contact');await page.getByRole('button',{name:'Close dialog',exact:true}).click();checks.push('英文人工入口和留资弹窗');
  const original=await page.locator('.messages').textContent();await page.getByRole('button',{name:'中文',exact:true}).click();await page.getByRole('button',{name:'新建对话',exact:true}).waitFor();assert.equal(await page.locator('.messages').textContent(),original);await page.reload();await page.getByRole('button',{name:'新建对话',exact:true}).waitFor();checks.push('中文切换记忆且历史原文保持');
  await page.getByRole('button',{name:'English',exact:true}).click();await page.getByRole('button',{name:'New conversation',exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:'New conversation',exact:true}).waitFor();checks.push('英文切换刷新记忆');
  await page.goto(`${env.cs}/demo/login?lang=en&inbox=1`);await page.locator('#items pre').filter({hasText:'visitor@example.test'}).waitFor();assert.match(await page.locator('#items pre').textContent(),/Fictional reference price: 8000–12000 CNY/);await capture('en-inbox');checks.push('英文收件箱');
  await page.goto(`${env.cs}/demo/login?lang=en`);await page.getByRole('button',{name:'Consultations',exact:true}).waitFor();await capture('en-admin');
  for(const [label,name] of [['Consultations','en-consultations'],['Reception settings','en-settings'],['Team accounts','en-team']]){
    if(await page.getByRole('button',{name:label,exact:true}).isVisible())await page.getByRole('button',{name:label,exact:true}).click();else{await page.getByRole('button',{name:'Open menu'}).click();await page.getByRole('button',{name:label,exact:true}).click();}
    await page.waitForTimeout(250);await capture(name);
  }
  checks.push('英文后台概览咨询设置账号');
  if(await page.getByRole('button',{name:'Reception settings',exact:true}).isVisible())await page.getByRole('button',{name:'Reception settings',exact:true}).click();else{await page.getByRole('button',{name:'Open menu'}).click();await page.getByRole('button',{name:'Reception settings',exact:true}).click();}
  for(const [label,name] of [['Model and knowledge base','en-settings-model'],['Handoff and notifications','en-settings-handoff'],['Service hours','en-settings-hours'],['Website integration','en-settings-embed']]){await page.getByRole('tab',{name:label,exact:true}).click();await capture(name);}
  checks.push('英文所有设置分类');
  await page.goto(`${env.kb}/demo/login?lang=en`);await page.getByText('Product images and copy assistant (fictional demo)',{exact:true}).waitFor();await capture('en-kb-list');
  await page.locator('#projectsList .card').filter({hasText:'Unreviewed test archive'}).click();await page.locator('#draftTitle').waitFor();await capture('en-kb-detail');
  page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Submit for review',exact:true}).click();await page.getByRole('button',{name:'Approve and publish',exact:true}).click();await page.getByRole('button',{name:'Confirm approval and publication',exact:true}).click();await page.locator('#wsProjectStatusBadge').filter({hasText:'Published'}).waitFor();checks.push('英文知识库审核');
  for(const [label,name] of [['Search and integration','en-kb-search'],['System and model settings','en-kb-settings'],['Staff accounts','en-kb-team']]){await page.getByRole('button',{name:label,exact:true}).click();await page.waitForTimeout(250);await capture(name);}
  await page.getByRole('button',{name:'中文',exact:true}).click();await page.getByRole('button',{name:'项目归档',exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:'项目归档',exact:true}).waitFor();checks.push('知识库语言记忆');
  const external=await browser.newContext({locale:'fr-FR'}),other=await external.newPage();await other.goto(env.cs);await other.getByRole('button',{name:'Product images',exact:true}).waitFor();await other.goto(`${env.cs}/?lang=zh`);await other.getByRole('button',{name:'商品图',exact:true}).waitFor();await external.close();checks.push('非中文回退英文与显式中文');
  assert.equal(errors.length,0);writeFileSync(path.join(folder,'results.json'),JSON.stringify({checks,layouts,errors,untranslated:[...new Set(untranslated)],realModelCalls:0,realWecomCalls:0},null,2));assert.equal(new Set(untranslated).size,0,'英文页面仍有未翻译界面文案');console.log(JSON.stringify({checks:checks.length,layouts:layouts.length,errors,untranslated:[...new Set(untranslated)]}));
}finally{await browser?.close();await env.stop();}
