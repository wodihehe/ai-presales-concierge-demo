// Explicit local HTTP mock; no external model or company materials.
import http from 'node:http';
export async function startMockModel() {
  const requests=[];
  let mode='normal';
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push(body);
    if(mode==='rate'){res.writeHead(429);res.end('SYNTHETIC_UPSTREAM_SECRET');return;}
    if(mode==='invalid'){res.end('not json');return;}
    if(mode==='slow'){res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();return;}
    let result;
    if(Array.isArray(body.messages.at(-1).content))result={text:'[SYNTHETIC_FIXTURE] 图片报价人民币 12000 元',uncertain:false};
    else if(body.messages.length===1)result='OK';
    else if(body.messages[0].content.includes('本次是员工聊天修正'))result={reply:'已按员工说明补充交付物。',patch:{deliverables:'[SYNTHETIC_FIXTURE] 测试培训手册'}};
    else {
      const message=body.messages.at(-1).content;
      const payload=JSON.parse(message.slice(message.indexOf('{')));
      const quote=payload.files.find(f=>f.extracted_text.includes('12000'));
      result={title:'[SYNTHETIC_FIXTURE] 工单工作流',category:'工作流搭建',scenario:'内部工单流转',overview:'根据最终方案整理工单自动创建与通知。',inputs:'工单表格',outputs:'处理通知',integrations:'无',deployment:'云端',deliverables:'培训材料',public_title:'工单工作流',public_summary:'自动创建工单并发送处理通知。',features:['自动创建工单','发送处理通知'],phases:[{phase_name:'一期',scope_description:'自动创建工单与发送处理通知',relation:'standalone',amount_min:12000,amount_max:12000,currency:'CNY',raw_amount_text:'一期最终报价人民币12000元',source_file_id:quote?.id,source_location:'报价原文片段',source_type:'file',allow_cs_quote:true}],style_references:[{topic:'方案组织',desensitized_example:'按目标、功能、交付边界组织方案。',source_file_id:payload.files[0].id,source_location:'方案开头'}]};
    }
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:typeof result==='string'?result:JSON.stringify(result)},finish_reason:mode==='truncated'?'length':'stop'}]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}/v1`,requests,setMode(value){mode=value;},close(){server.closeAllConnections();return new Promise(r=>server.close(r));}};
}
