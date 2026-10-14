import english from './en.json' with { type: 'json' };
export const languages = ['zh','en'];
export const validLocale = value => languages.includes(value) ? value : null;
const templateEntries = Object.entries(english).filter(([key])=>key.includes('{0}')).map(([key,value])=>{
  const pattern=key.split(/(\{\d+\})/).map(part=>/^\{\d+\}$/.test(part)?'([\\s\\S]*?)':part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('');
  return {pattern:new RegExp(`^${pattern}$`),value};
});
export function t(value,locale='zh') {
  if(locale!=='en'||typeof value!=='string')return value;
  if(Object.hasOwn(english,value))return english[value];
  const clean=value.trim();
  if(Object.hasOwn(english,clean))return value.replace(clean,english[clean]);
  if(/[、；]/.test(clean)){const parts=clean.split(/[、；]/);if(parts.every(part=>Object.hasOwn(english,part.trim())))return parts.map(part=>english[part.trim()]).join('; ');}
  for(const entry of templateEntries){const match=clean.match(entry.pattern);if(match)return value.replace(clean,entry.value.replace(/\{(\d+)\}/g,(_,i)=>match[Number(i)+1]??''));}
  return value;
}
export function canonicalDemoText(value){
  if(typeof value!=='string')return value;
  if(/[;；]/.test(value)){const parts=value.split(/[;；]/).map(part=>part.trim()),mapped=parts.map(canonicalDemoText);if(mapped.every((part,i)=>part!==parts[i]))return mapped.join('；');}
  // Exact bilingual fixture terms only. Arbitrary uploaded content is not machine-translated.
  const pair=Object.entries(english).find(([key,en])=>en===value&&/^(商品|生成商品|生成详情|电商商品|不自动发布|企业内网|本地模型部署|知识问答|权限控制|内部文档|带来源|不对接其他|询价|整理询价|归类需求|消息通知|需求摘要|销售询价|未审核测试|此草稿|这条草稿|演示范围|演示方案组织|虚构方案|按素材准备|明确输入|先确认数据)/.test(key));
  return pair?.[0]||value;
}
export function translateLines(value,locale){
  if(locale!=='en'||typeof value!=='string')return value;
  const direct=t(value,locale);if(direct!==value)return direct;
  return value.split('\n').map(line=>t(line,locale)).join('\n');
}
