import crypto from 'node:crypto';
import { getDatabase, transaction } from '../db/index.js';
import { writableProject, checkVersion, invalidateDraft, fail } from './projectAccess.js';

const fields = ['title','category','scenario','problem','overview','inputs','outputs','integrations','deployment','deliverables','exclusions','public_title','public_summary'];
const relations = ['standalone','cumulative','alternative','unknown'];
export const newId = prefix => `${prefix}_${crypto.randomUUID()}`;
export function validAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
}
export function validPhasePrice(p) {
  return p.allow_cs_quote === 1 && relations.includes(p.relation) && p.relation !== 'unknown' && /^[A-Z]{3}$/.test(p.currency) && validAmount(p.amount_min) && validAmount(p.amount_max) && p.amount_min <= p.amount_max && Boolean(p.scope_description?.trim());
}
function text(value, max=20000) {
  if (typeof value !== 'string' || value.length > max) fail('invalid_draft','草稿字段类型或长度不正确',400);
  return value.trim();
}

// A partial update preserves omitted fields and requires an exact snapshot version.
// AI is never allowed to grant quote permission or silently designate a source file.
export function saveDraft(projectId,userId,data,expectedVersion,{ model=false, chat=false }={}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid_draft','整理结果必须为对象',400);
  const db=getDatabase();
  return transaction(()=>{
    const project=writableProject(projectId,userId);
    checkVersion(project,expectedVersion);
    const updates=[],params=[];
    for(const field of fields) if(Object.hasOwn(data,field)) {
      updates.push(`${field}=?`);params.push(text(data[field]));
    }
    if(updates.length) db.prepare(`UPDATE projects SET ${updates.join(',')} WHERE id=?`).run(...params,projectId);
    if(Object.hasOwn(data,'features')) {
      if(!Array.isArray(data.features)||data.features.length>100) fail('invalid_draft','功能列表格式错误',400);
      const old = db.prepare('SELECT * FROM project_features WHERE project_id=? ORDER BY order_index').all(projectId);
      db.prepare('DELETE FROM project_features WHERE project_id=?').run(projectId);
      data.features.forEach((f,i)=>{
        const value=text(typeof f==='string'?f:f?.feature_text,2000);
        const previous=old.find(item=>item.feature_text===value);
        const isPublic=typeof f==='object' ? f.is_public===true||f.is_public===1 : previous ? previous.is_public===1 : true;
        db.prepare('INSERT INTO project_features(id,project_id,feature_text,is_public,order_index) VALUES(?,?,?,?,?)').run(newId('feat'),projectId,value,isPublic?1:0,i);
      });
    }
    if(Object.hasOwn(data,'phases')) {
      if(!Array.isArray(data.phases)||data.phases.length>100) fail('invalid_draft','阶段列表格式错误',400);
      const old=db.prepare('SELECT * FROM project_phases WHERE project_id=?').all(projectId);
      const phases=data.phases.map((raw,i)=>{
        if(!raw||typeof raw!=='object'||Array.isArray(raw)) fail('invalid_draft','阶段格式错误',400);
        const previous=old.find(p=>p.id===raw.id);
        const p={...previous,...raw};
        const relation=relations.includes(p.relation)?p.relation:'unknown';
        const min=p.amount_min??null,max=p.amount_max??null;
        if((min!==null&&!validAmount(min))||(max!==null&&!validAmount(max))||(min!==null&&max!==null&&min>max)) fail('invalid_amount','金额须为正数且最多两位小数；不确定请留空',400);
        let fileId=p.source_file_id||null,sourceType=p.source_type||'staff_supplement';
        if(fileId&&!db.prepare('SELECT 1 FROM project_files WHERE id=? AND project_id=?').get(fileId,projectId)) fail('invalid_source','来源附件不属于本项目',400);
        if(model&&!chat&&fileId) {
          const file=db.prepare('SELECT extracted_text FROM project_files WHERE id=? AND project_id=?').get(fileId,projectId);
          if(p.raw_amount_text && !file.extracted_text.includes(p.raw_amount_text)) fail('invalid_source','模型报价原文无法在所标附件中核对，请人工补充',400);
          sourceType='file';
        }
        if(model&&!chat&&(min!==null||max!==null)&&(!fileId||!p.raw_amount_text)) fail('invalid_source','模型金额缺少可核对的来源文件与原文',400);
        if(chat){fileId=null;sourceType='staff_supplement';}
        if(!['file','staff_supplement'].includes(sourceType)) fail('invalid_source','来源类型错误',400);
        if(sourceType==='file'&&!fileId) fail('invalid_source','请指定报价来源附件或改为人工补充',400);
        const changed=previous && ['amount_min','amount_max','currency','raw_amount_text','scope_description','relation'].some(k=>Object.hasOwn(raw,k)&&raw[k]!==previous[k]);
        // Explicit manual changes must not pretend to remain the old file's literal facts.
        if(!model&&changed&&!Object.hasOwn(raw,'source_file_id')){fileId=null;sourceType='staff_supplement';}
        return {id:previous?.id||newId('phase'),name:text(p.phase_name||`阶段${i+1}`,2000),scope:text(p.scope_description||''),relation,min,max,currency:text(p.currency||'',20).toUpperCase(),raw:text(p.raw_amount_text||''),cost:text(p.cost_scope||''),fileId,location:chat?'员工聊天补充':text(p.source_location||''),sourceType,allow:!model&&(p.allow_cs_quote===true||p.allow_cs_quote===1)?1:0,i};
      });
      db.prepare('DELETE FROM project_phases WHERE project_id=?').run(projectId);
      const insert=db.prepare('INSERT INTO project_phases(id,project_id,phase_name,scope_description,relation,amount_min,amount_max,currency,raw_amount_text,cost_scope,source_file_id,source_location,source_type,allow_cs_quote,order_index) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for(const p of phases) insert.run(p.id,projectId,p.name,p.scope,p.relation,p.min,p.max,p.currency,p.raw,p.cost,p.fileId,p.location,p.sourceType,p.allow,p.i);
    }
    if(Object.hasOwn(data,'style_references')) {
      if(!Array.isArray(data.style_references)||data.style_references.length>50) fail('invalid_draft','风格依据格式错误',400);
      db.prepare('DELETE FROM style_references WHERE project_id=?').run(projectId);
      for(const s of data.style_references) {
        const source=s.source_file_id||null;
        if(source&&!db.prepare('SELECT 1 FROM project_files WHERE id=? AND project_id=?').get(source,projectId)) fail('invalid_source','风格来源不属于本项目',400);
        db.prepare("INSERT INTO style_references VALUES(?,?,?,?,?,?,datetime('now'))").run(newId('style'),projectId,text(s.topic),text(s.desensitized_example),source,text(s.source_location||''));
      }
    }
    invalidateDraft(projectId);
    db.prepare("INSERT INTO audit_logs VALUES(?,?,?,'project',?,?,datetime('now'))").run(newId('audit'),userId,model?'ai_draft':'update_draft',projectId,JSON.stringify({draft_version:expectedVersion+1}));
    return {success:true,draft_version:expectedVersion+1};
  });
}
