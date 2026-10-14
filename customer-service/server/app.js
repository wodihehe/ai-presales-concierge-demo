import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import {rateLimit} from 'express-rate-limit';
import multer from 'multer';
import {readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import path from 'node:path';
import {id,hash,verifyPassword,passwordHash,urlSetting} from './security.js';
import {generateReply,retrieveQuote,isProfileReady,generateKnowledgeReply} from './intelligence.js';
import {parseAttachment} from './attachments.js';
import {serviceStatus,validateSchedule} from './schedule.js';
import {queueLead,notificationWorker} from './notifications.js';
import {validateIntakeAction} from './intake-actions.js';
import {validateContactAction,contactFieldError,hasContactChannel} from './contact-actions.js';
import { localize } from '../../shared/server-locale.js';

const err=(message,status=400)=>Object.assign(new Error(message),{status});
const text=(v,max=2000)=>typeof v==='string'?v.trim().slice(0,max):'';
const secretNames=['clearModelKey','clearKnowledgeKey','clearWebhook'];
export function createApp(store,{replyFn=generateReply,quoteFn=retrieveQuote,referenceFn=generateKnowledgeReply,parseFn=parseAttachment,fetchImpl=fetch,production=process.env.NODE_ENV==='production',rateLimits=true}={}) {
  const app=express(),locked=new Set();
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5_000_000,files:1,fields:5,parts:6}});
  app.disable('x-powered-by');
  if(process.env.TRUST_PROXY==='1')app.set('trust proxy',1);
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','blob:'],connectSrc:["'self'"],frameAncestors:["'self'"],upgradeInsecureRequests:production?[]:null}},crossOriginEmbedderPolicy:false}));
  app.use((req,res,next)=>{
    const origins=store.settings().embedOrigins||[];
    res.setHeader('Content-Security-Policy',res.getHeader('Content-Security-Policy').replace(/frame-ancestors [^;]+/,`frame-ancestors 'self' ${origins.join(' ')}`));
    if(origins.length)res.removeHeader('X-Frame-Options');
    if(req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store');
    next();
  });
  app.use(cookieParser());app.use(express.json({limit:'64kb'}));
  const cookie={httpOnly:true,sameSite:'lax',secure:production,path:'/'};
  app.use('/api',(req,res,next)=>{
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      const origin=req.get('origin');
      const expected=`${req.protocol}://${req.get('host')}`;
      const dev=['http://127.0.0.1:3219','http://localhost:3219'];
      if((origin&&origin!==expected&&!( !production&&dev.includes(origin))) || req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'请求来源不匹配，请刷新当前页面再试。'});
    }
    next();
  });
  if(rateLimits)app.use('/api',rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'操作有些频繁，请稍后再试。'}}));
  const strictLimiter=rateLimits?rateLimit({windowMs:15*60000,limit:15,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'登录尝试较多，请稍后再试。'}}):(req,res,next)=>next();
  const modelLimiter=rateLimits?rateLimit({windowMs:60000,limit:15,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'消息较多，请稍等片刻再发送。'}}):(req,res,next)=>next();
  function owner(req,res){let token=req.cookies.visitor;if(!/^[\w-]{32}$/.test(token||'')){token=id();res.cookie('visitor',token,{...cookie,maxAge:30*86400000});}return hash(token);}
  function visitor(req,res,next){req.owner=owner(req,res);next();}
  function user(req,res,next){req.user=store.sessionUser(req.cookies.admin_session);if(!req.user)return res.status(401).json({error:'请先登录管理后台。'});next();}
  function admin(req,res,next){if(req.user.role!=='admin')return res.status(403).json({error:'此操作仅管理员可用。'});next();}
  function getOwned(req){if(!store.owns(req.params.cid,req.owner))throw err('咨询不存在或已过保存期限。',404);return store.getConversation(req.params.cid);}
  function adminC(req){const c=store.getConversation(req.params.cid);if(!c)throw err('咨询不存在或已过保存期限。',404);return c;}
  function filePublic(a){return {id:a.id,name:a.name,size:a.size,mime:a.mime,status:a.status,note:a.note,url:`/api/files/${a.id}`};}
  function present(c,isAdmin=false){
    const {requestIds,quoteSources,knowledgeReplySources,messages,contact,contactEvidence,contactNeedsReview,notificationReason,...rest}=c;
    const ns=store.notifications(c.id).map(({payload,fingerprint,...n})=>isAdmin?n:{id:n.id,status:n.status,attempts:n.attempts,lastError:n.lastError,createdAt:n.createdAt});
    return {...rest,messages:messages.map(({knowledgeReference,...message})=>message),attachments:store.attachments(c.id).map(filePublic),notifications:ns,contactSubmitted:!!contact?.consent&&!contactNeedsReview,...(isAdmin?{contact:contact&&contactNeedsReview?{...contact,consent:false}:contact,quoteSources,knowledgeReplySources:knowledgeReplySources||[],notificationReason}:{})};
  }
  function safeSettings(s){return {...s,model:{...s.model,apiKey:'',configured:!!(s.model.baseUrl&&s.model.name&&s.model.apiKey)},knowledge:{...s.knowledge,apiKey:'',configured:!!s.knowledge.url},wecom:{webhook:'',configured:!!s.wecom.webhook}};}
  function addMessage(c,role,content,attachments=[]){c.messages.push({id:id(),role,content:role==='assistant'?localize(content):content,createdAt:new Date().toISOString(),attachments});}
  function cancelPending(cid){store.db.prepare("UPDATE notifications SET status='superseded' WHERE conversation_id=? AND status<>'sent'").run(cid);}
  function contactReceipt(c) {
    const receipt=originalContactReceipt(c);
    if(store.settings().demo?.localNotifications&&c.contact?.consent&&!c.contactNeedsReview&&c.profile.project){
      const notification=store.notifications(c.id).find(n=>n.status!=='superseded');
      return notification?.status==='sent'
        ? '项目和联系方式已登记，本地演示通知已记录。没有发送企业微信，点击“演示收件箱”查看简报。'
        : '项目和联系方式已登记，本地演示通知正在处理。没有发送企业微信，稍后点击“演示收件箱”查看简报。';
    }
    return store.settings().demo?.localNotifications ? receipt.replaceAll('群通知','本地演示通知').replaceAll('已发送成功','已记录（未发送企业微信）').replaceAll('扫码沟通','查看人工入口') : receipt;
  }
  function originalContactReceipt(c) {
    if(c.contactNeedsReview)return '联系方式还需要核实，跟进通知已暂停。请提供希望同事用于本项目联系的手机号、微信号或邮箱，也可以点击“联系人工”填写。';
    if(!c.contact?.consent)return '联系方式已登记，暂时不会通知同事跟进。你愿意让同事通过这个联系方式沟通本次项目吗？';
    if(!c.profile.project?.trim())return '联系方式和联系意愿已登记啦～请再简单说说你的项目，方便把需求交给同事跟进。';
    const notification=store.notifications(c.id).find(n=>n.status!=='superseded');
    const settings=store.settings(),service=serviceStatus(settings.schedule);
    const schedule=settings.schedule.days.length?`\n人工服务时间：${service.label}。${service.isOpen?'':'同事会在人工服务时段处理。'}`:'';
    if(notification?.status==='sent')return `你的项目和联系方式已登记，群通知已发送成功。后续由同事继续沟通方案与报价。${schedule}`;
    if(!settings.wecom.webhook)return `你的项目和联系方式已登记；群通知尚未发送，正在等待通知配置。也可以点击“联系人工”扫码沟通。${schedule}`;
    if(notification&&['failed','retrying','awaiting_configuration'].includes(notification.status))return `你的项目和联系方式已登记，但群通知尚未确认发送成功。可以点击“联系人工”扫码沟通。${schedule}`;
    return `你的项目和联系方式已登记，已加入同事跟进的通知队列，正在发送。方案和报价由同事进一步评估。${schedule}`;
  }
  function registerContact(c,{fields={},consent,evidence=null,replace=false,scopeChanged=false}={}) {
    const previous=c.contact,previousNeedsReview=c.contactNeedsReview===true;
    const contact={...Object.fromEntries(['phone','wechat','email','name','company'].map(key=>[key,replace?'':previous?.[key]||''])),...fields,consent:consent===true};
    if(!hasContactChannel(contact))throw err('手机号、微信号、邮箱，至少填一种有效联系方式就好。');
    for(const key of ['phone','wechat','email','name','company'])if(contactFieldError(key,contact[key]))throw err('请检查联系方式格式，手机号、微信号或邮箱任选一种即可。');
    const changed=JSON.stringify(previous)!==JSON.stringify(contact);
    c.contact=contact;delete c.contactNeedsReview;c.handoff=true;
    if(evidence)c.contactEvidence=evidence;
    else delete c.contactEvidence;
    if(changed||scopeChanged)cancelPending(c.id);
    store.saveConversation(c);
    // Compare the current scope even if contact details are unchanged: an
    // earlier failed contact action may have left only an old sent snapshot.
    // Pure repeated contact wording alone must not create another notification.
    if(contact.consent)queueLead(store,c,{force:previous?.consent===false||previousNeedsReview,ignoreLatestCustomerNote:!changed&&!scopeChanged});
    return contactReceipt(c);
  }
  function executeContact(c,action,{scopeChanged=false}={}) {
    if(action.type==='withdraw'){
      if(c.contact)c.contact.consent=false;
      delete c.contactNeedsReview;
      c.contactEvidence={type:'withdraw',sourceMessageId:action.sourceMessageId};
      cancelPending(c.id);store.saveConversation(c);
      return '收到，已停止后续跟进通知。已发到企业微信群的信息无法自动撤回，你仍然可以继续咨询。';
    }
    return registerContact(c,{fields:Object.fromEntries(Object.entries(action.fields).map(([key,item])=>[key,item.value])),
      consent:action.consent==='granted',scopeChanged,evidence:{type:'save',sourceMessageId:action.sourceMessageId,
        fieldSources:Object.fromEntries(Object.entries(action.fields).map(([key,item])=>[key,item.sourceMessageId]))}});
  }
  async function withLock(cid,action){if(locked.has(cid))throw err('上一条请求还在处理中，请稍等。',409);locked.add(cid);try{return await action();}finally{locked.delete(cid);}}
  async function referenceReply(c,mode,question='') {
    let result;
    try { result=await referenceFn({settings:store.settings(),profile:structuredClone(c.profile),question,mode}); }
    catch { result={status:'unavailable'}; }
    if(!store.getConversation(c.id))throw err('咨询已删除或过期。',410);
    c.knowledgeReplySources=[];
    if(result?.status==='ok'&&typeof result.reply==='string'&&result.reply.trim()&&result.reply.length<=2500
      &&Array.isArray(result.sources)&&result.sources.length>0&&result.sources.length<=3
      &&result.sources.every(source=>typeof source==='string'&&source.length>0&&source.length<=128)){
      c.knowledgeReplySources=[...new Set(result.sources)];
      addMessage(c,'assistant',result.reply);
      // Do not feed a saved reference response back into future intake as if
      // it were current knowledge. Every reference request performs a new lookup.
      c.messages.at(-1).knowledgeReference=true;
    }else if(mode==='answer'){
      const message=result?.status==='no_match'
        ? '当前没有找到与这份需求匹配且可引用的公司案例，这个方案细节需要同事进一步评估。之前的参考内容不能代替当前依据。'
        : result?.status==='model_unavailable'
          ? '这次没能可靠地整理案例说明，先不补充未经核对的方案细节。你的需求已保留，最终方案请同事进一步确认。'
          : '目前暂时无法取得可用的公司方案依据，先不沿用之前的参考内容。这个问题请同事结合当前需求进一步确认。';
      addMessage(c,'assistant',message);
    }
  }
  async function confirmRequirements(c,{replyToRepeat=false}={}) {
    if(!c.summaryReady||!isProfileReady(c.profile))throw err('请先补充并整理最新需求，或直接联系人工。');
    if(c.summaryConfirmed){
      if(replyToRepeat){
        addMessage(c,'assistant',c.quote?'这份需求已经确认啦～参考报价仍以页面展示的区间为准，最终方案和价格由同事确认。你可以留下联系方式继续沟通。':'这份需求已经确认啦～目前仍需同事评估方案和报价。你可以扫码联系人工，或留一种联系方式继续沟通，无需重复确认。');
        store.saveConversation(c);
      }
      return;
    }
    let result;
    try { result=await quoteFn({settings:store.settings(),profile:c.profile,version:c.summaryVersion}); }
    catch { result={status:'unavailable',quote:null,sources:[]}; }
    if(!store.getConversation(c.id))throw err('咨询已删除或过期。',410);
    c.summaryConfirmed=true;c.knowledgeStatus=result.status;c.quote=result.quote;c.quoteSources=result.sources;
    c.handoff=!result.quote;c.notificationReason=result.status==='no_match'?'新类型项目，暂无同类案例':'需求已确认，待顾问跟进';
    c.knowledgeReplySources=[];
    addMessage(c,'assistant',result.quote?'需求确认好啦～已根据可用的公司同类案例整理参考区间，最终价格仍由同事确认。你觉得这个范围符合预期吗？':result.status==='no_match'?'需求确认好啦～这类项目暂时没有可参考的公司案例，需要同事先评估方案和报价。你可以扫码联系人工，或留下手机号、微信号、邮箱中的一种，方便继续沟通。':'需求确认好啦～目前没有足够的报价依据，需要由同事先评估方案和报价。你可以扫码联系人工，或留下手机号、微信号、邮箱中的一种，方便继续沟通。');
    await referenceReply(c,'proposal');
    store.saveConversation(c);queueLead(store,c);
  }
  const tick=notificationWorker(store,{fetchImpl});
  app.get('/api/health',(req,res)=>res.json({ok:true}));
  app.get('/api/public/config',(req,res)=>{const s=store.settings(),service=serviceStatus(s.schedule);res.json({companyName:s.companyName,companyDescription:s.companyDescription,qrUrl:s.qrUrl,service:{...service,message:!s.schedule.days.length?'留下联系方式，顾问会后续与你联系。':service.isOpen?s.daytimeMessage:s.nighttimeMessage},modelConfigured:!!(s.model.baseUrl&&s.model.name&&s.model.apiKey),retentionDays:30,maxFileBytes:5_000_000});});
  app.get('/api/session',visitor,(req,res)=>res.json({conversation:present(store.latest(req.owner)||store.createConversation(req.owner))}));
  app.post('/api/conversations',visitor,(req,res)=>res.json({conversation:present(store.createConversation(req.owner))}));
  app.get('/api/conversations/:cid',visitor,(req,res)=>res.json({conversation:present(getOwned(req))}));
  app.post('/api/conversations/:cid/messages',visitor,modelLimiter,async(req,res)=>withLock(req.params.cid,async()=>{
    const c=getOwned(req),content=text(req.body.content,4000),requestId=text(req.body.requestId,100);
    if(!requestId)throw err('缺少消息标识，请刷新后重试。');
    if(c.requestIds.includes(requestId))return res.json({conversation:present(c)});
    const aids=req.body.attachmentIds||[];
    if(!Array.isArray(aids)||aids.length>3||new Set(aids).size!==aids.length)throw err('每条消息最多附上 3 个不同文件。');
    const files=aids.map(aid=>store.attachment(aid));
    if(files.some(a=>!a||a.conversationId!==c.id))throw err('附件不属于当前咨询。',403);
    if(!content&&!files.length)throw err('先写点内容或上传需求文件吧。');
    if(c.messages.length>=240)throw err('本次咨询内容较多，请联系人工或新建咨询。');
    // Bind all new-client messages to the state the customer actually saw.
    // This also prevents accepting a new quote from a stale browser tab.
    const hasVersion=Object.hasOwn(req.body,'summaryVersion');
    if(hasVersion&&(!Number.isSafeInteger(req.body.summaryVersion)||req.body.summaryVersion!==c.summaryVersion))throw err('需求有更新，请刷新并确认最新版本。',409);
    addMessage(c,'user',content||'请看看我上传的需求材料。',files.map(filePublic));
    c.requestIds.push(requestId);store.saveConversation(c);
    if(/不要联系我|别联系我|不用跟进|停止联系|撤回同意|取消联系/.test(content)){
      if(c.contact)c.contact.consent=false;
      delete c.contactNeedsReview;
      store.db.prepare("UPDATE notifications SET status='superseded' WHERE conversation_id=? AND status<>'sent'").run(c.id);
      addMessage(c,'assistant','收到，我会停止后续跟进通知。已发送到企业微信群的信息无法自动撤回；你仍然可以继续咨询。');store.saveConversation(c);return res.json({conversation:present(c)});
    }
    const snapshot=structuredClone({profile:c.profile,summaryVersion:c.summaryVersion,summaryReady:c.summaryReady,
      summaryConfirmed:c.summaryConfirmed,quote:c.quote,quoteSources:c.quoteSources,feedback:c.feedback,
      knowledgeStatus:c.knowledgeStatus,handoff:c.handoff,notificationReason:c.notificationReason,knowledgeReplySources:c.knowledgeReplySources||[]});
    const conversationState={summaryVersion:snapshot.summaryVersion,summaryReady:snapshot.summaryReady,
      summaryConfirmed:snapshot.summaryConfirmed,quote:snapshot.quote?{version:snapshot.quote.version,min:snapshot.quote.min,max:snapshot.quote.max,currency:snapshot.quote.currency}:null,
      feedback:snapshot.feedback,knowledgeStatus:snapshot.knowledgeStatus,hasNewAttachments:files.length>0,
      contactAvailable:hasContactChannel(c.contact),contactConsented:!!c.contact?.consent&&!c.contactNeedsReview,
      contactFields:['phone','wechat','email','name','company'].filter(key=>!!c.contact?.[key])};
    const latestMessage=structuredClone(c.messages.at(-1)),holdToken=id();
    // While the Skill interprets the message, no old price is actionable. The
    // orthogonal hold preserves delivery progress without sending stale scope.
    store.db.exec('BEGIN IMMEDIATE');
    try{
      store.db.prepare('INSERT INTO notification_holds(conversation_id,token) VALUES(?,?)').run(c.id,holdToken);
      c.summaryVersion++;c.summaryConfirmed=false;c.summaryReady=false;c.quote=null;c.quoteSources=[];c.feedback='not_quoted';c.knowledgeStatus='unavailable';
      c.knowledgeReplySources=[];
      store.saveConversation(c);store.db.exec('COMMIT');
    }catch(error){store.db.exec('ROLLBACK');throw error;}
    let settled=false;
    try{
      const selected=store.attachments(c.id).filter(a=>c.messages.some(m=>m.attachments?.some(f=>f.id===a.id))).slice(-6).map(a=>({...a,dataUrl:a.kind==='image'?`data:${a.mime};base64,${readFileSync(path.join(store.dir,'files',a.id)).toString('base64')}`:undefined}));
      let result;
      try{result=await replyFn({settings:store.settings(),profile:structuredClone(snapshot.profile),messages:c.messages.slice(-40),attachments:selected,conversationState});}
      catch{result={profile:snapshot.profile,ready:false,degraded:true,reply:'抱歉呀，需求分析暂时没有完成。你可以留下项目说明和联系方式，或点击“联系人工”，请顾问继续帮你梳理。'};}
      if(!store.getConversation(c.id))throw err('咨询已被删除或过期。',410);
      const contactCheck=validateContactAction(result?.contactAction,{messages:c.messages.slice(-40),existingContact:c.contact});
      if(!contactCheck.valid||result?.contactReviewRequired===true){
        c.contactNeedsReview=true;cancelPending(c.id);store.saveConversation(c);
      }
      if(!contactCheck.valid||(result?.contactReviewRequired===true&&contactCheck.action)){
        const validScope=validateIntakeAction(result,{state:conversationState,profile:snapshot.profile,message:latestMessage});
        result={profile:validScope?.type==='continue'?result.profile:snapshot.profile,ready:false,degraded:true,reply:'这次没能可靠地登记联系方式，暂时没有提交跟进通知。请检查手机号、微信号或邮箱，也可以点击“联系人工”填写表单。'};
      }
      const action=validateIntakeAction(result,{state:conversationState,profile:snapshot.profile,message:latestMessage});
      const contactAction=action&&!result.degraded&&result.contactReviewRequired!==true&&contactCheck.valid?contactCheck.action:null;
      if(action&&action.type!=='continue'){
        Object.assign(c,snapshot);
        if(!hasVersion&&['confirm_requirements','quote_feedback'].includes(action.type)){
          addMessage(c,'assistant','这条回复我收到啦～请先刷新页面，查看最新需求和参考报价，再用文字或页面按钮确认，避免确认到旧版本。');
          store.saveConversation(c);
        }else if(action.type==='confirm_requirements'){
          await confirmRequirements(c,{replyToRepeat:true});
        }else if(action.type==='quote_feedback'){
          const changed=c.feedback!==action.feedback;c.feedback=action.feedback;
          addMessage(c,'assistant','收到你的反馈啦～可以留下手机号、微信号或邮箱，方便同事继续和你确认方案。');
          store.saveConversation(c);if(changed)queueLead(store,c);
        }else if(!contactAction){
          if(result.referenceRequested===true&&c.summaryConfirmed)await referenceReply(c,'answer',latestMessage.content);
          else addMessage(c,'assistant',result.reply);
          store.saveConversation(c);
        }
        if(contactAction){addMessage(c,'assistant',executeContact(c,contactAction));store.saveConversation(c);}
        settled=true;
        return res.json({conversation:present(c),degraded:false});
      }
      // Legacy injected adapters without action remain ordinary intake only.
      // A malformed action must never fall through to a confirmable summary.
      if(result&&Object.hasOwn(result,'action')&&!action){result={profile:snapshot.profile,ready:false,degraded:true,reply:'这次没能可靠地判断你的意思，暂时没有确认需求或报价。可以换个说法补充，或点击“联系人工”继续沟通。'};}
      c.profile=result.profile||snapshot.profile;c.summaryReady=!!result.ready&&isProfileReady(c.profile);
      if(result.degraded){c.handoff=true;c.summaryReady=false;}
      cancelPending(c.id);
      if(contactAction){
        const receipt=executeContact(c,contactAction,{scopeChanged:true});
        addMessage(c,'assistant',[result.reply,receipt].filter(Boolean).join('\n\n'));store.saveConversation(c);
      }else{addMessage(c,'assistant',result.reply);store.saveConversation(c);if(contactCheck.valid)queueLead(store,c);}
      settled=true;
      res.json({conversation:present(c),degraded:!!result.degraded});
    }finally{
      if(!settled)cancelPending(c.id);
      store.db.prepare('DELETE FROM notification_holds WHERE conversation_id=? AND token=?').run(c.id,holdToken);
    }
  }));
  app.post('/api/conversations/:cid/attachments',visitor,modelLimiter,upload.single('file'),async(req,res)=>withLock(req.params.cid,async()=>{
    const c=getOwned(req);if(!req.file)throw err('请选择文件。');
    if(store.attachments(c.id).length>=20)throw err('每次咨询最多保存 20 个附件，请新建咨询或联系人工。');
    const decodedName=Buffer.from(req.file.originalname,'latin1').toString('utf8');
    const parsed=await parseFn({buffer:req.file.buffer,name:[...req.file.originalname].some(ch=>ch.charCodeAt(0)>255)||decodedName.includes('\uFFFD')?req.file.originalname:decodedName,mime:req.file.mimetype});
    if(!store.getConversation(c.id))throw err('咨询已过期。',410);
    const a={...parsed,id:id(),conversationId:c.id,size:req.file.size,createdAt:new Date().toISOString()};
    writeFileSync(path.join(store.dir,'files',a.id),req.file.buffer,{mode:0o600});store.saveAttachment(a);res.json({attachment:filePublic(a)});
  }));
  app.post('/api/conversations/:cid/confirm',visitor,async(req,res)=>withLock(req.params.cid,async()=>{
    const c=getOwned(req);if(req.body.version!==c.summaryVersion)throw err('需求有更新，请确认最新版本。',409);
    await confirmRequirements(c);res.json({conversation:present(c)});
  }));
  app.post('/api/conversations/:cid/feedback',visitor,(req,res)=>{
    if(locked.has(req.params.cid))throw err('当前咨询正在更新，请稍后重试。',409);
    const c=getOwned(req);if(!['accepted','too_high','considering'].includes(req.body.feedback))throw err('请选择有效反馈。');
    if(!c.quote||req.body.version!==c.quote.version)throw err('参考报价已更新，请查看最新方案。',409);
    c.feedback=req.body.feedback;store.saveConversation(c);queueLead(store,c);res.json({conversation:present(c)});
  });
  app.post('/api/conversations/:cid/handoff',visitor,(req,res)=>{if(locked.has(req.params.cid))throw err('当前咨询正在更新，请稍后重试。',409);const c=getOwned(req);c.handoff=true;c.notificationReason='客户主动请求人工';store.saveConversation(c);queueLead(store,c);res.json({conversation:present(c)});});
  app.post('/api/conversations/:cid/contact',visitor,(req,res)=>{
    if(locked.has(req.params.cid))throw err('当前咨询正在更新，请稍后重试。',409);
    const c=getOwned(req),b=req.body;
    if(b.consent===false){if(c.contact)c.contact.consent=false;delete c.contactNeedsReview;store.saveConversation(c);store.db.prepare("UPDATE notifications SET status='superseded' WHERE conversation_id=? AND status<>'sent'").run(c.id);return res.json({conversation:present(c),message:'已停止后续跟进通知。已发送到企业微信群的信息无法自动撤回。'});}
    if(b.consent!==true)throw err('请确认愿意由我们的同事联系你。');
    const contact={phone:text(b.phone,32),wechat:text(b.wechat,64),email:text(b.email,254),name:text(b.name,80),company:text(b.company,160),consent:true};
    if(!contact.phone&&!contact.wechat&&!contact.email)throw err('手机号、微信号、邮箱，至少填一种就好。');
    for(const key of ['phone','wechat','email','name','company'])if(contactFieldError(key,contact[key]))throw err('请检查联系方式格式。');
    const project=text(b.project,1000),scopeChanged=!!project&&project!==c.profile.project;if(scopeChanged){c.profile.project=project;c.summaryVersion++;c.summaryConfirmed=false;c.summaryReady=false;c.quote=null;c.quoteSources=[];c.knowledgeReplySources=[];c.feedback='not_quoted';}
    if(!c.profile.project)c.profile.project=text(c.profile.problem||c.profile.scenario,1000);
    if(c.profile.project.length<4)throw err('请简单描述项目或想解决的问题，方便同事跟进。');
    const message=registerContact(c,{fields:contact,consent:true,replace:true,scopeChanged});
    res.json({conversation:present(c),message});
  });
  app.get('/api/files/:aid',(req,res)=>{
    const a=store.attachment(req.params.aid),u=store.sessionUser(req.cookies.admin_session),ownerKey=req.cookies.visitor?hash(req.cookies.visitor):'';
    if(!a||!store.getConversation(a.conversationId)||(!u&&!store.owns(a.conversationId,ownerKey)))throw err('文件不存在或无权访问。',404);
    res.setHeader('X-Content-Type-Options','nosniff');res.download(path.join(store.dir,'files',a.id),a.name);
  });
  app.get('/api/public/qr',(req,res)=>{const file=path.join(store.dir,'qr-image');if(!existsSync(file))throw err('尚未配置人工二维码。',404);res.type(store.settings().qrMime||'image/png').sendFile(file);});

  app.get('/api/admin/bootstrap',(req,res)=>res.json({needsSetup:store.users().length===0}));
  app.post('/api/admin/login',strictLimiter,(req,res)=>{
    const u=store.db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(text(req.body.username,64));
    if(!u||!verifyPassword(req.body.password,u.password))throw err('用户名或密码不正确。',401);
    const token=id();store.db.prepare('INSERT INTO auth_sessions VALUES(?,?,?)').run(hash(token),u.id,Date.now()+12*3600000);res.cookie('admin_session',token,{...cookie,maxAge:12*3600000});res.json({user:{id:u.id,username:u.username,role:u.role}});
  });
  app.get('/api/admin/me',user,(req,res)=>res.json({user:req.user}));
  app.post('/api/admin/logout',(req,res)=>{store.db.prepare('DELETE FROM auth_sessions WHERE token=?').run(hash(req.cookies.admin_session||''));res.clearCookie('admin_session',cookie);res.json({ok:true});});
  app.get('/api/admin/overview',user,(req,res)=>{const cs=store.conversations(),s=safeSettings(store.settings());res.json({total:cs.length,pending:cs.filter(c=>c.contact?.consent&&c.followupStatus==='pending').length,won:cs.filter(c=>c.followupStatus==='won').length,notificationFailed:store.db.prepare("SELECT count(*) AS n FROM notifications WHERE status IN ('failed','retrying','awaiting_configuration')").get().n,modelConfigured:s.model.configured,knowledgeConfigured:s.knowledge.configured,wecomConfigured:s.wecom.configured});});
  app.get('/api/admin/conversations',user,(req,res)=>{let cs=store.conversations();const q=text(req.query.q,100).toLowerCase(),status=text(req.query.status,20);if(q)cs=cs.filter(c=>JSON.stringify({profile:c.profile,contact:c.contact}).toLowerCase().includes(q));if(status)cs=cs.filter(c=>c.followupStatus===status);res.json({conversations:cs.map(c=>present(c,true))});});
  app.get('/api/admin/conversations/:cid',user,(req,res)=>res.json({conversation:present(adminC(req),true)}));
  app.patch('/api/admin/conversations/:cid',user,(req,res)=>{if(locked.has(req.params.cid))throw err('当前咨询正在更新，请稍后重试。',409);const c=adminC(req);if(!['pending','following','won','lost'].includes(req.body.followupStatus))throw err('无效跟进状态。');c.followupStatus=req.body.followupStatus;store.saveConversation(c);res.json({conversation:present(c,true)});});
  app.delete('/api/admin/conversations/:cid',user,admin,(req,res)=>{adminC(req);store.deleteConversation(req.params.cid);res.json({ok:true});});
  app.delete('/api/admin/files/:aid',user,admin,(req,res)=>{
    const a=store.attachment(req.params.aid);if(!a)throw err('文件不存在。',404);
    if(locked.has(a.conversationId))throw err('当前咨询正在更新，请稍后再删除附件。',409);
    const c=store.getConversation(a.conversationId);
    if(c){for(const m of c.messages)m.attachments=(m.attachments||[]).filter(f=>f.id!==a.id);c.summaryConfirmed=false;c.summaryReady=false;c.summaryVersion++;c.quote=null;c.quoteSources=[];c.knowledgeReplySources=[];c.feedback='not_quoted';c.knowledgeStatus='unavailable';store.saveConversation(c);store.db.prepare("UPDATE notifications SET status='superseded' WHERE conversation_id=? AND status<>'sent'").run(c.id);}
    rmSync(path.join(store.dir,'files',a.id),{force:true});store.db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);res.json({ok:true});
  });
  app.post('/api/admin/notifications/:nid/retry',user,(req,res)=>{const row=store.db.prepare('SELECT data,status FROM notifications WHERE id=?').get(req.params.nid);if(!row)throw err('通知不存在。',404);const n=JSON.parse(row.data);if(locked.has(n.conversationId)||store.db.prepare('SELECT 1 FROM notification_holds WHERE conversation_id=?').get(n.conversationId))throw err('当前咨询正在更新，请稍后重试。',409);if(['sent','superseded'].includes(row.status))throw err('通知已经发送或已被新版本替代，无需重复发送。');if(!store.getConversation(n.conversationId))throw err('对应咨询已过期。',410);n.status='pending';n.nextAt=Date.now();n.attempts=0;store.saveNotification(n);res.json({ok:true});});
  app.get('/api/admin/settings',user,admin,(req,res)=>res.json({settings:safeSettings(store.settings())}));
  app.put('/api/admin/settings',user,admin,(req,res)=>{
    const old=store.settings(),b=req.body,s={...old};
    s.companyName=text(b.companyName,80)||old.companyName;s.companyDescription=text(b.companyDescription,2000);
    s.model={baseUrl:urlSetting(b.model?.baseUrl,'模型接口'),name:text(b.model?.name,100),apiKey:b.clearModelKey?'':text(b.model?.apiKey,1000)||old.model.apiKey};
    s.knowledge={url:urlSetting(b.knowledge?.url,'知识库接口'),apiKey:b.clearKnowledgeKey?'':text(b.knowledge?.apiKey,1000)||old.knowledge.apiKey};
    s.wecom=old.demo?.localNotifications?{webhook:'demo://local-notification'}:{webhook:b.clearWebhook?'':urlSetting(b.wecom?.webhook,'企微机器人',{wecom:true})||old.wecom.webhook};
    s.schedule=validateSchedule(b.schedule||old.schedule);s.daytimeMessage=text(b.daytimeMessage,300)||old.daytimeMessage;s.nighttimeMessage=text(b.nighttimeMessage,300)||old.nighttimeMessage;
    if(!Array.isArray(b.embedOrigins)||b.embedOrigins.length>10)throw err('官网来源最多填写 10 个。');
    s.embedOrigins=b.embedOrigins.map(o=>{const v=urlSetting(o,'官网来源');const u=new URL(v);if(u.origin!==v||u.protocol!=='https:')throw err('官网来源应为 HTTPS 域名，不带路径。');return u.origin;});
    for(const k of secretNames)delete s[k];store.saveSettings(s);
    store.db.prepare("UPDATE notifications SET next_at=? WHERE status='awaiting_configuration'").run(Date.now());
    res.json({settings:safeSettings(s)});
  });
  app.post('/api/admin/qr',user,admin,upload.single('file'),async(req,res)=>{
    if(!req.file)throw err('请选择二维码图片。');const a=await parseFn({buffer:req.file.buffer,name:req.file.originalname,mime:req.file.mimetype});if(a.kind!=='image')throw err('二维码请上传 PNG、JPEG 或 WebP 图片。');
    writeFileSync(path.join(store.dir,'qr-image'),req.file.buffer,{mode:0o600});const s=store.settings();s.qrUrl=`/api/public/qr?v=${Date.now()}`;s.qrMime=a.mime;store.saveSettings(s);res.json({qrUrl:s.qrUrl});
  });
  app.get('/api/admin/users',user,admin,(req,res)=>res.json({users:store.users()}));
  app.post('/api/admin/users',user,admin,(req,res)=>{try{res.json({user:store.createUser(req.body.username,req.body.password,req.body.role)});}catch(e){if(e.code?.includes('SQLITE'))throw err('用户名已存在。');throw e;}});
  app.patch('/api/admin/users/:uid',user,admin,(req,res)=>{
    const target=store.users().find(u=>u.id===req.params.uid);if(!target)throw err('账号不存在。',404);
    if(req.body.active===false&&target.id===req.user.id)throw err('不能停用当前登录账号。');
    if(req.body.active===false&&target.role==='admin'&&store.users().filter(u=>u.active&&u.role==='admin').length<=1)throw err('至少保留一位启用的管理员。');
    if(typeof req.body.active==='boolean')store.db.prepare('UPDATE users SET active=? WHERE id=?').run(req.body.active?1:0,target.id);
    if(req.body.password)store.db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(req.body.password),target.id);
    store.db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(target.id);res.json({ok:true});
  });
  app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在。'}));
  const dist=path.resolve('dist');
  app.use(express.static(dist));
  app.get('/{*path}',(req,res)=>{if(existsSync(path.join(dist,'index.html')))res.sendFile(path.join(dist,'index.html'),{dotfiles:'allow'});else res.status(503).type('text').send('前端尚未构建，请运行 npm run dev 或 npm run build。');});
  app.use((e,req,res,next)=>{if(res.headersSent)return next(e);const status=e.code==='LIMIT_FILE_SIZE'?413:e instanceof multer.MulterError?400:Number.isInteger(e.status)?e.status:500;res.status(status).json({error:e.code==='LIMIT_FILE_SIZE'?'单个文件不能超过 5MB。':status>=500?'服务暂时遇到问题，请稍后重试或联系人工。':e.message});});
  return {app,tick};
}
