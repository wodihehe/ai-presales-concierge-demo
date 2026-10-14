import {installLocaleUI,getLocale} from '/demo/shared/browser-locale.js';
import {t} from '/demo/shared/i18n.js';
installLocaleUI();
function englishBrief(p){
  const contact=p.contact||{},feedback={accepted:'Reference range accepted (human approval pending)',too_high:'Price considered high',considering:'Considering',not_quoted:'Not quoted'},translate=v=>t(v,'en');
  return ['[LOCAL DEMO · No WeCom message sent]',`Project: ${translate(p.project)}`,
    `Contact: ${[contact.phone&&`Phone ${contact.phone}`,contact.wechat&&`WeChat ${contact.wechat}`,contact.email&&`Email ${contact.email}`].filter(Boolean).join('; ')} (follow-up consent given)`,
    contact.name&&`Name: ${contact.name}`,contact.company&&`Company: ${contact.company}`,'',p.confirmed?'Requirements (customer confirmed)':'Requirements (awaiting confirmation)',
    p.scenario&&`Scenario: ${translate(p.scenario)}`,...(p.features||[]).map(f=>`• ${translate(f)}`),p.inputs&&`Inputs: ${translate(p.inputs)}`,p.outputs&&`Outputs: ${translate(p.outputs)}`,p.integrations&&`Integrations: ${translate(p.integrations)}`,'',
    p.quote?`Fictional reference price: ${p.quote.min}–${p.quote.max} ${p.quote.currency}; subject to human approval`:'No quote: requires manual assessment',`Feedback: ${feedback[p.feedback]||'Not provided'}`,p.timeline&&`Preferred timeline: ${p.timeline}`].filter(v=>v!==false&&v!==undefined&&v!==null).join('\n');
}
async function load(){
  const container=document.getElementById('items');container.replaceChildren();
  try{
    const response=await fetch('/demo/api/inbox');if(!response.ok)throw new Error('请先点击客服页面上的“演示收件箱”登录入口。');
    const {items}=await response.json();
    if(!items.length){container.textContent='还没有通知。确认项目、留一种虚构联系方式并同意跟进后，即可看到简报。';return;}
    for(const item of items){const article=document.createElement('article'),title=document.createElement('h2'),pre=document.createElement('pre');title.textContent=t(item.project,getLocale());pre.textContent=getLocale()==='en'&&item.payload?englishBrief(item.payload):`【本地演示 · 未发送企业微信】\n${item.parts.join('\n\n')}`;article.append(title,pre);container.append(article);}
  }catch(error){container.textContent=error.message;}
}
document.getElementById('refresh').addEventListener('click',load);load();
// The first visit can precede the persisted notification worker by a few milliseconds.
// Keep the local receipt current instead of leaving the initial empty state on screen.
setInterval(load,2000);
window.addEventListener('demo-locale-change',load);
