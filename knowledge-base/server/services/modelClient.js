import { getDatabase } from '../db/index.js';
import {currentLocale} from '../../../shared/server-locale.js';
export class ModelClient {
  static getSettings() {
    const config=Object.fromEntries(getDatabase().prepare("SELECT key,value FROM settings WHERE key IN ('model_base_url','model_name','model_api_key','model_supports_vision')").all().map(r=>[r.key,r.value]));
    return {baseUrl:config.model_base_url||'',modelName:config.model_name||'',apiKey:config.model_api_key||'',supportsVision:['true','1'].includes(config.model_supports_vision)};
  }
  static isConfigured(settings=ModelClient.getSettings()) {return Boolean(settings.baseUrl?.trim()&&settings.modelName?.trim()&&settings.apiKey?.trim());}
  static formatEndpoint(baseUrl) {
    const parsed=new URL(baseUrl.trim());
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('模型地址需为无账号、查询参数及片段的HTTP(S)地址');
    let url=parsed.toString().replace(/\/+$/,'');
    if(!url.endsWith('/chat/completions'))url+=(url.endsWith('/v1')?'':'/v1')+'/chat/completions';
    return url;
  }
  static async request(settings,payload,timeoutMs) {
    if(!ModelClient.isConfigured(settings))return {success:false,reason:'not_configured',message:'请配置模型地址、名称和密钥'};
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetch(ModelClient.formatEndpoint(settings.baseUrl),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${settings.apiKey.trim()}`},body:JSON.stringify({model:settings.modelName.trim(),...payload}),signal:controller.signal});
      if(!response.ok){await response.body?.cancel();return {success:false,reason:response.status===429?'rate_limited':'api_error',message:`模型请求失败（HTTP ${response.status}），请检查配置或稍后重试`};}
      const reader=response.body.getReader();let size=0;const chunks=[];
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024){controller.abort();return {success:false,reason:'response_too_large',message:'模型响应超过4MB，未应用整理结果'};}chunks.push(Buffer.from(value));}
      let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return {success:false,reason:'invalid_json',message:'模型未返回有效JSON响应'};}
      const choice=data.choices?.[0],content=choice?.message?.content;
      if(choice?.finish_reason==='length')return {success:false,reason:'truncated',message:'模型输出因长度限制被截断，未应用不完整结果'};
      if(typeof content!=='string'||!content.trim())return {success:false,reason:'empty_response',message:'模型没有返回有效文本内容'};
      return {success:true,content:content.trim(),usage:data.usage};
    } catch(err) {return {success:false,reason:controller.signal.aborted?'timeout':'network_error',message:controller.signal.aborted?'模型请求超时，已有材料保留':'模型网络连接失败，请检查地址及服务状态'};}
    finally{clearTimeout(timeout);}
  }
  static async testConnection(settings) {
    const started=Date.now();
    const result=await ModelClient.request(settings,{messages:[{role:'user',content:'请回复OK'}],max_tokens:32},15000);
    return result.success?{success:true,latencyMs:Date.now()-started}:{success:false,error:result.message};
  }
  static async chatCompletion({messages,responseFormat=null,temperature=0.3,maxTokens=4000,timeoutMs=30000}) {
    const preference=`工作台回复语言：${currentLocale()==='en'?'English':'简体中文'}。解释和问题用此语言；原件来源片段、事实、金额、JSON协议键名保持原样。不要因为语言切换编造资料。`;
    messages=messages.map((message,index)=>index===0&&message.role==='system'?{...message,content:message.content+'\n'+preference}:message);
    return ModelClient.request(ModelClient.getSettings(),{messages,temperature,max_tokens:maxTokens,...(responseFormat?{response_format:responseFormat}:{})},timeoutMs);
  }
}
