import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { CONFIG } from '../server/config.js';
import { initDatabase,closeDatabase } from '../server/db/index.js';
import { extractDocumentText } from '../server/services/fileParser.js';

function pdf(text) {
  const stream=`BT /F1 12 Tf 40 740 Td (${text}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let output='%PDF-1.4\n';const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const start=Buffer.byteLength(output);output+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return output;
}
test('真实PDF和DOCX格式及截断回归 [SYNTHETIC_FIXTURE]',async t=>{
  initDatabase(':memory:');t.after(closeDatabase);
  const dir=path.join(CONFIG.DATA_DIR,'formats');fs.mkdirSync(dir,{recursive:true});
  await t.test('DOCX正文与表格报价被实际提取',async()=>{
    const zip=new JSZip();
    zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>[SYNTHETIC_FIXTURE] 最终方案</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>二期报价人民币20000元</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
    const file=path.join(dir,'synthetic.docx');fs.writeFileSync(file,await zip.generateAsync({type:'nodebuffer'}));
    const result=await extractDocumentText(file,'synthetic.docx','');assert.equal(result.parse_status,'parsed',result.parse_error_reason);assert.match(result.extracted_text,/二期报价人民币20000元/);
  });
  await t.test('PDF文本层实际提取，无文本不能伪称已解析',async()=>{
    const file=path.join(dir,'synthetic.pdf');fs.writeFileSync(file,pdf('SYNTHETIC_FIXTURE Final CNY 12000'));
    const result=await extractDocumentText(file,'synthetic.pdf','');assert.equal(result.parse_status,'parsed',result.parse_error_reason);assert.match(result.extracted_text,/12000/);
    fs.writeFileSync(file,pdf(''));const empty=await extractDocumentText(file,'synthetic.pdf','');assert.equal(empty.parse_status,'failed');
  });
  await t.test('长文截断明确标partial，错误编码及损坏Office失败',async()=>{
    const file=path.join(dir,'long.txt');fs.writeFileSync(file,'[SYNTHETIC_FIXTURE] '+ '报价'.repeat(110000));
    const result=await extractDocumentText(file,'long.txt','');assert.equal(result.parse_status,'partial');assert.equal(result.extracted_text.length,CONFIG.MAX_EXTRACT_CHARS);assert.match(result.parse_error_reason,/未纳入/);
    fs.writeFileSync(file,Buffer.from([255,255,255]));assert.equal((await extractDocumentText(file,'broken.txt','')).parse_status,'failed');assert.equal((await extractDocumentText(file,'broken.docx','')).parse_status,'failed');
  });
});
