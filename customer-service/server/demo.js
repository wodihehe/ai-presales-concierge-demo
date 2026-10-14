import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createApp } from './app.js';
import { hash, id } from './security.js';
import { demoReply, demoReference, demoQuote, realModelConfigured } from './demo-adapter.js';
import { csData } from '../../scripts/paths.js';
import {localeMiddleware,currentLocale} from '../../shared/server-locale.js';
import {t,translateLines} from '../../shared/i18n.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const store=openStore(csData,{recoverNotificationHolds:true});
const outer=express();outer.disable('x-powered-by');outer.use(cookieParser());
outer.use(localeMiddleware);
outer.use('/demo/shared',express.static(path.join(root,'shared'),{dotfiles:'allow'}));
outer.use('/demo',(req,res,next)=>{
  const loopback=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  let validHost=false;try{validHost=['127.0.0.1','localhost'].includes(new URL(`http://${req.headers.host}`).hostname);}catch{}
  if(!loopback||!validHost||req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'演示辅助入口仅支持本机访问'});
  if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return res.status(403).json({error:'来源不匹配'});
  res.setHeader('Cache-Control','no-store');next();
});
outer.get('/demo/status',(req,res)=>res.json({mode:realModelConfigured(store.settings())?'live':'offline',kbPort:Number(process.env.DEMO_KB_PORT||3320)}));
outer.get('/demo/login',(req,res)=>{
  const user=store.users().find(u=>u.role==='admin'&&u.active),token=id();
  store.db.prepare('INSERT INTO auth_sessions VALUES(?,?,?)').run(hash(token),user.id,Date.now()+12*3600000);
  res.cookie('admin_session',token,{httpOnly:true,sameSite:'strict',path:'/',maxAge:12*3600000});
  res.cookie('demo_locale',currentLocale(),{sameSite:'lax',path:'/',maxAge:365*86400000});
  res.redirect(`${req.query.inbox==='1'?'/demo/inbox':'/admin'}?lang=${currentLocale()}`);
});
const authorized=(req,res,next)=>store.sessionUser(req.cookies.admin_session)?.role==='admin'?next():res.status(401).json({error:'请通过演示后台入口登录'});
outer.get('/demo/api/inbox',authorized,(req,res)=>{
  const items=store.conversations().flatMap(c=>store.notifications(c.id).filter(n=>n.status==='sent').map(n=>({id:n.id,createdAt:n.sentAt,project:c.profile.project,parts:n.renderedParts||[],payload:n.payload,localOnly:true}))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  res.json({items,localOnly:true});
});
outer.get('/demo/inbox',authorized,(req,res)=>res.sendFile(path.join(root,'customer-service/demo-inbox.html'),{dotfiles:'allow'}));
outer.get('/demo/inbox.js',(req,res)=>res.sendFile(path.join(root,'customer-service/demo-inbox.js'),{dotfiles:'allow'}));
const localDelivery=async()=>new Response(JSON.stringify({errcode:0}),{headers:{'Content-Type':'application/json'}});
const {app,tick}=createApp(store,{replyFn:demoReply,quoteFn:demoQuote,referenceFn:demoReference,fetchImpl:localDelivery,production:false});
outer.use(app);
const server=outer.listen(Number(process.env.PORT||3318),'127.0.0.1',()=>console.log('客服演示已启动：离线或自配模型，通知只记录本机。'));
const timer=setInterval(()=>tick().catch(()=>console.error('本地演示通知处理失败')),500);timer.unref();
const cleanup=setInterval(()=>store.cleanup(),60000);cleanup.unref();
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{clearInterval(timer);clearInterval(cleanup);server.close(()=>{store.close();process.exit(0);});});
