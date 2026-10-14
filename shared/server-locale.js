import { AsyncLocalStorage } from 'node:async_hooks';
import {t,translateLines,validLocale,canonicalDemoText} from './i18n.js';
const context=new AsyncLocalStorage();
export const currentLocale=()=>context.getStore()||'zh';
export const localize=value=>translateLines(value,currentLocale());
export function localeMiddleware(req,res,next){
  const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('demo_locale='))?.split('=')[1];
  const locale=validLocale(req.query.lang)||validLocale(raw)||((req.headers['accept-language']||'zh').toLowerCase().startsWith('zh')?'zh':req.headers['accept-language']&&req.headers['accept-language']!=='*'?'en':'zh');
  const json=res.json.bind(res);
  res.json=body=>{
    const copy=value=>{
      if(Array.isArray(value))return value.map(copy);
      if(!value||typeof value!=='object')return value;
      const displayFields=['error','message','reply','note','companyName','companyDescription','title','public_title','public_summary','overview','summary','scenario','inputs','outputs','integrations','deliverables','scope_description','phase_name','topic','desensitized_example','example','feature_text','parse_error_reason','error_message'];
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,displayFields.includes(key)&&typeof item==='string'?translateLines(item,locale):key==='features'&&Array.isArray(item)?item.map(v=>t(v,locale)):copy(item)]));
    };
    return json(copy(body));
  };
  context.run(locale,next);
}
export function normalizeDemoQuery(body){
  if(!body||typeof body!=='object')return body;
  const profile=body.profile&&typeof body.profile==='object'?Object.fromEntries(Object.entries(body.profile).map(([key,value])=>[key,Array.isArray(value)?value.map(canonicalDemoText):canonicalDemoText(value)])):body.profile;
  return {...body,profile,query:typeof body.query==='string'?body.query.split('\n').map(canonicalDemoText).join('\n'):body.query};
}
