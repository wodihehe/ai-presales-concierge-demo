import { hash,id } from './security.js';
import { briefParts } from './lead-brief.js';

const feedbackLabels={accepted:'接受参考区间（待人工确认）',too_high:'价格偏高',considering:'待考虑',not_quoted:'尚未报价'};
export function queueLead(store,c,{force=false,ignoreLatestCustomerNote=false}={}) {
  if(!c.contact?.consent || c.contactNeedsReview || !c.profile.project?.trim()) return false;
  const p=c.profile;
  const lastCustomerMessage=[...c.messages].reverse().find(m=>m.role==='user')?.content||'';
  const payload={project:p.project,scenario:p.scenario,problem:p.problem,features:p.features,inputs:p.inputs,outputs:p.outputs,integrations:p.integrations,budget:p.budget,timeline:p.timeline,confirmed:c.summaryConfirmed,quote:c.quote,feedback:c.feedback,contact:c.contact,knowledgeStatus:c.knowledgeStatus,reason:c.notificationReason||'客户愿意接受项目跟进',latestCustomerNote:c.summaryConfirmed?'':lastCustomerMessage};
  const fingerprint=hash(JSON.stringify(payload)+id());
  const last=store.db.prepare('SELECT data,status FROM notifications WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(c.id);
  const comparable=value=>ignoreLatestCustomerNote?{...value,latestCustomerNote:''}:value;
  if(!force&&last&&last.status!=='superseded'&&JSON.stringify(comparable(JSON.parse(last.data).payload))===JSON.stringify(comparable(payload)))return false;
  store.db.prepare("UPDATE notifications SET status='superseded' WHERE conversation_id=? AND fingerprint<>? AND status IN ('pending','retrying','awaiting_configuration','failed')").run(c.id,fingerprint);
  store.enqueue(c.id,fingerprint,payload); return true;
}
// Retained only for partially sent jobs created before brief-format rollout.
function legacyMessageParts(payload) {
  const p=payload;
  const quote=p.quote?`${p.quote.min}–${p.quote.max} ${p.quote.currency}，最终待人工确认`:'尚未报价，需人工评估';
  const text=[`【网站客户咨询】${p.project}`,`需求${p.confirmed?'（客户已确认）':'（待补充确认）'}：${p.problem||p.scenario||p.project}`,`功能：${p.features?.join('；')||'待沟通'}`,`输入／输出：${p.inputs||'待沟通'} ／ ${p.outputs||'待沟通'}`,`系统对接：${p.integrations||'待沟通'}`,`预算／期望时间：${p.budget||'未提供'} ／ ${p.timeline||'未提供'}`,`参考报价：${quote}`,`客户反馈：${feedbackLabels[p.feedback]||'尚未报价'}`,`联系方式：${[p.contact.phone&&'手机 '+p.contact.phone,p.contact.wechat&&'微信 '+p.contact.wechat,p.contact.email&&'邮箱 '+p.contact.email].filter(Boolean).join('；')}`,p.contact.name&&`称呼：${p.contact.name}`,p.contact.company&&`公司：${p.contact.company}`,p.latestCustomerNote&&`客户最新补充（原文，待人工核实）：${p.latestCustomerNote}`,`跟进原因：${p.reason}`,`说明：已获客户联系意愿；方案及报价待人工最终确认。`].filter(Boolean).join('\n');
  const parts=[];let part='';for(const ch of text){if(Buffer.byteLength(part+ch)>1800){parts.push(part);part='';}part+=ch;}if(part)parts.push(part);
  return parts.map((p,i)=>parts.length>1?`【项目通知 ${i+1}/${parts.length}】\n${p}`:p);
}
export function messageParts(payload) { return briefParts(payload); }
export function notificationWorker(store,{fetchImpl=fetch}={}) {
  let busy=false;
  return async function tick() {
    if(busy)return;busy=true;
    try {
      const webhook=store.settings().wecom.webhook;
      const rows=store.db.prepare("SELECT data,status FROM notifications WHERE status IN ('pending','retrying','awaiting_configuration') AND next_at<=? AND NOT EXISTS (SELECT 1 FROM notification_holds h WHERE h.conversation_id=notifications.conversation_id) LIMIT 10").all(Date.now());
      for(const row of rows) {
        const n={...JSON.parse(row.data),status:row.status},c=store.getConversation(n.conversationId);
        if(!c?.contact?.consent||c.contactNeedsReview)continue;
        if(store.db.prepare('SELECT 1 FROM notification_holds WHERE conversation_id=?').get(n.conversationId))continue;
        if(!webhook){n.status='awaiting_configuration';n.lastError='企业微信群机器人尚未配置';n.nextAt=Date.now()+60000;store.saveNotification(n);continue;}
        n.attempts+=1;
        try {
          // Freeze before the first request. Retries (including after process
          // restart) must use the exact same text and split boundaries.
          if(!n.renderedParts){
            n.formatVersion=(n.sentParts||0)>0?1:2;
            n.renderedParts=n.formatVersion===1?legacyMessageParts(n.payload):messageParts(n.payload);
            store.saveNotification(n);
          }
          const parts=n.renderedParts;
          for(let i=n.sentParts||0;i<parts.length;i++){
            const liveStatus=store.db.prepare('SELECT status FROM notifications WHERE id=?').get(n.id)?.status;
            const liveContact=store.getConversation(n.conversationId);
            if(!['pending','retrying','awaiting_configuration'].includes(liveStatus)||!liveContact?.contact?.consent||liveContact.contactNeedsReview
              ||store.db.prepare('SELECT 1 FROM notification_holds WHERE conversation_id=?').get(n.conversationId))break;
            const response=await fetchImpl(webhook,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({msgtype:'text',text:{content:parts[i]}}),signal:AbortSignal.timeout(10000)});
            if(!response.ok)throw new Error('http');
            if(Number(response.headers.get('content-length')||0)>10000)throw new Error('oversize');
            const reader=response.body.getReader(),chunks=[];let bytes=0;
            try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>10000)throw new Error('oversize');chunks.push(Buffer.from(chunk.value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
            const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if(body?.errcode!==0)throw new Error('rejected');
            n.sentParts=i+1;store.saveNotification(n);
          }
          if((n.sentParts||0)!==parts.length)continue;
          const current=store.getConversation(n.conversationId);
          if(!current?.contact?.consent||current.contactNeedsReview)continue;
          if(store.db.prepare('SELECT status FROM notifications WHERE id=?').get(n.id)?.status==='superseded')continue;
          n.status='sent';n.lastError='';n.sentAt=new Date().toISOString();n.nextAt=0;
        } catch {
          n.status=n.attempts>=5?'failed':'retrying';n.lastError='群通知发送未确认成功，请检查机器人配置和网络。';n.nextAt=Date.now()+Math.min(3600000,30000*2**(n.attempts-1));
        }
        // A deletion may happen while awaiting upstream; UPDATE cannot recreate records.
        const live=store.db.prepare('SELECT status FROM notifications WHERE id=?').get(n.id);
        if(live&&live.status!=='superseded')store.saveNotification(n);
      }
    } finally {busy=false;}
  };
}
