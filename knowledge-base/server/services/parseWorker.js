import fs from 'node:fs';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import * as xlsx from 'xlsx';

function inspectZip(buffer) {
  // Reject ZIP64 and excessive uncompressed payloads before Office parsers allocate.
  let end=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--) if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0) throw new Error('Office压缩包格式无效');
  const count=buffer.readUInt16LE(end+10),offset=buffer.readUInt32LE(end+16);
  if(count===65535||count>2000||offset===0xffffffff) throw new Error('Office压缩包条目或资源上限超出');
  let cursor=offset,total=0;
  for(let i=0;i<count;i++) {
    if(cursor+46>buffer.length||buffer.readUInt32LE(cursor)!==0x02014b50) throw new Error('Office目录损坏');
    const compressed=buffer.readUInt32LE(cursor+20),size=buffer.readUInt32LE(cursor+24);
    total+=size;
    if(size===0xffffffff||total>64*1024*1024||(size>1024*1024&&size/Math.max(compressed,1)>200)) throw new Error('Office解压资源上限超出');
    cursor+=46+buffer.readUInt16LE(cursor+28)+buffer.readUInt16LE(cursor+30)+buffer.readUInt16LE(cursor+32);
  }
}
process.once('message',async({filePath,ext,maxChars})=>{
  try {
    const buffer=fs.readFileSync(filePath);
    let text='',note='';
    if(ext==='.docx') {inspectZip(buffer);const result=await mammoth.extractRawText({buffer});text=result.value;}
    else if(ext==='.pdf') {
      // pdf.js expects copying slice semantics; Node Buffer.slice shares memory.
      const data=await pdfParse(new Uint8Array(buffer));text=data.text;
      if(!text.trim())throw new Error('PDF未提取到文本，可能是扫描件或文本层不可读；暂不支持自动OCR，请提供图片或可读文本');
    }
    else if(['.xlsx','.xls','.csv'].includes(ext)) {
      if(ext==='.xlsx') inspectZip(buffer);
      const wb=xlsx.read(buffer,{type:'buffer',sheetRows:10001});
      const parts=[];let rowsLimited=false;
      for(const name of wb.SheetNames){const sheet=wb.Sheets[name];if(sheet['!fullref']&&sheet['!fullref']!==sheet['!ref']) rowsLimited=true;parts.push(`=== 工作表 [${name}] ===\n${xlsx.utils.sheet_to_csv(sheet)}`);}
      text=parts.join('\n\n');if(rowsLimited)note='表格只覆盖每个工作表前10001行，其余未提取，请补充关键报价';
    } else if(['.txt','.md','.markdown','.json','.log','.xml','.yaml','.yml'].includes(ext)) {
      if(buffer[0]===255&&buffer[1]===254) text=buffer.subarray(2).toString('utf16le');
      else text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
    } else {
      process.send({parse_status:'unsupported',extracted_text:'',parse_error_reason:ext==='.doc'?'旧版.doc暂不支持，原件保留，请另存为.docx 或 PDF':'当前格式无法自动提取结构化文本，原件保留，请补充可读文本'});return;
    }
    text=String(text||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'').trim();
    if(!text)throw new Error('未检测到可提取文字');
    if(text.length>maxChars)note+=` 仅提取前${maxChars}字符，后续内容未纳入。`;
    process.send({parse_status:note?'partial':'parsed',extracted_text:text.slice(0,maxChars),parse_error_reason:note});
  } catch(err) {process.send({parse_status:'failed',extracted_text:'',parse_error_reason:`解析未完成：${String(err.message).slice(0,180)}；原件保留`});}
});
