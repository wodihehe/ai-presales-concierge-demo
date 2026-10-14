import express from 'express';
import path from 'node:path';
import { CONFIG } from './config.js';
import { initDatabase, getDatabase, closeDatabase } from './db/index.js';
import { createApp } from './index.js';
import { createSessionToken } from './middleware/auth.js';
import { acquireRuntimeLock } from './db/runtimeLock.js';
import {localeMiddleware,currentLocale,normalizeDemoQuery} from '../../shared/server-locale.js';
import {t,canonicalDemoText} from '../../shared/i18n.js';
const release=acquireRuntimeLock();process.once('exit',release);initDatabase(CONFIG.DB_PATH,{recoverTasks:true});
const outer=express();
outer.use(localeMiddleware);
outer.use('/demo/shared',express.static(path.resolve(CONFIG.ROOT_DIR,'../shared'),{dotfiles:'allow'}));
outer.use('/api/integrations',express.json({limit:'128kb'}),(req,res,next)=>{req.body=normalizeDemoQuery(req.body);next();});
outer.use('/api/projects/:id/draft',express.json({limit:'10mb'}),(req,res,next)=>{
  if(req.method==='PUT'&&['demo-commerce','demo-workflow','demo-local','demo-draft'].includes(req.params.id)){
    const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)])):canonicalDemoText(value);
    req.body=normalize(req.body);
  }
  next();
});
outer.get('/demo/login',(req,res)=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!['127.0.0.1','localhost'].includes(new URL(`http://${req.headers.host}`).hostname)||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`))return res.status(403).json({error:'演示入口仅支持本机访问'});
  const user=getDatabase().prepare("SELECT * FROM users WHERE id='demo_admin' AND disabled=0").get();
  res.cookie(CONFIG.SESSION_COOKIE_NAME,createSessionToken(user),{httpOnly:true,sameSite:'strict',path:'/'});
  res.cookie('demo_locale',currentLocale(),{sameSite:'lax',path:'/',maxAge:365*86400000});
  res.setHeader('Cache-Control','no-store');res.redirect(`/?lang=${currentLocale()}`);
});
outer.use(createApp());
const server=outer.listen(CONFIG.PORT,'127.0.0.1',()=>console.log('知识库演示已启动：3个虚构公开案例、1个未审核草稿。'));
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>server.close(()=>{release();closeDatabase();process.exit(0);}));
