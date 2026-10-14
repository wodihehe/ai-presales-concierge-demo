import {t,validLocale} from './i18n.js';
const key='demo_locale';let active,installed=false;
export function getLocale(){
  if(active)return active;
  const explicit=validLocale(new URL(location.href).searchParams.get('lang'));
  const cookie=validLocale(document.cookie.split('; ').find(row=>row.startsWith(`${key}=`))?.split('=')[1]);
  let saved;try{saved=validLocale(localStorage.getItem(key));}catch{}
  active=explicit||cookie||saved||((navigator.language||'zh').toLowerCase().startsWith('zh')?'zh':'en');
  document.cookie=`${key}=${active}; Path=/; SameSite=Lax; Max-Age=31536000`;
  document.documentElement.lang=active==='zh'?'zh-CN':'en';return active;
}
export function setLocale(value){
  if(!validLocale(value))return;active=value;
  try{localStorage.setItem(key,value);}catch{}
  document.cookie=`${key}=${value}; Path=/; SameSite=Lax; Max-Age=31536000`;
  const url=new URL(location.href);url.searchParams.delete('lang');history.replaceState(history.state,'',url);
  document.documentElement.lang=value==='zh'?'zh-CN':'en';
  window.dispatchEvent(new CustomEvent('demo-locale-change',{detail:value}));
}
export function installLocaleUI(){
  if(installed)return;installed=true;getLocale();
  const textSources=new WeakMap(),attributeSources=new WeakMap();let titleSource=document.title,titleOutput=titleSource;
  const excluded='[data-original], [data-no-i18n], .messages, .chat-messages, #wsChatMessages, #wsSourceDetails, pre, code, script, style, textarea';
  function render(){
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const node=walker.currentNode;if(!node.parentElement||node.parentElement.closest(excluded))continue;
      const old=textSources.get(node),source=old&&node.data===old.output?old.source:node.data,output=t(source,getLocale());
      textSources.set(node,{source,output});if(node.data!==output)node.data=output;
    }
    for(const node of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')){
      if(node.closest('[data-no-i18n]'))continue;
      const saved=attributeSources.get(node)||{};
      for(const attr of ['placeholder','title','aria-label','alt'])if(node.hasAttribute(attr)){
        const value=node.getAttribute(attr),entry=saved[attr],source=entry&&entry.output===value?entry.source:value,output=t(source,getLocale());
        saved[attr]={source,output};if(value!==output)node.setAttribute(attr,output);
      }
      attributeSources.set(node,saved);
    }
    if(document.title!==titleOutput)titleSource=document.title;
    titleOutput=t(titleSource,getLocale());document.title=titleOutput;
    for(const node of document.querySelectorAll('[data-locale-button]'))node.setAttribute('aria-pressed',String(node.dataset.localeButton===getLocale()));
  }
  let queued=false;const schedule=()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;render();});};
  const start=()=>{render();new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['placeholder','title','aria-label','alt']});};
  if(document.body)start();else document.addEventListener('DOMContentLoaded',start,{once:true});
  window.addEventListener('demo-locale-change',schedule);
  document.addEventListener('click',event=>{const button=event.target.closest('[data-locale-button]');if(button)setLocale(button.dataset.localeButton);});
  const alertOriginal=window.alert,confirmOriginal=window.confirm,promptOriginal=window.prompt;
  window.alert=value=>alertOriginal(t(value,getLocale()));window.confirm=value=>confirmOriginal(t(value,getLocale()));window.prompt=(value,defaultValue)=>promptOriginal(t(value,getLocale()),defaultValue);
}
