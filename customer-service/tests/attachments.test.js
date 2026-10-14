import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { parseAttachment, MAX_FILE_BYTES, MAX_EXTRACTED_CHARS } from '../server/attachments.js';

const xlsx = createRequire(import.meta.url)('xlsx');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0YAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=', 'base64');
const WEBP = Buffer.from('52494646240000005745425056503820180000003001009d012a0100010001402625a400037000fefb940000', 'hex');

// Small valid archive writer keeps fixtures in-memory and makes dangerous metadata testable.
function zip(entries) {
  const records = [];
  const directory = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const body = deflateRawSync(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(filename.length, 26);
    records.push(header, filename, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += header.length + filename.length + body.length;
  }
  const ending = Buffer.alloc(22);
  ending.writeUInt32LE(0x06054b50); ending.writeUInt16LE(entries.length, 8); ending.writeUInt16LE(entries.length, 10);
  ending.writeUInt32LE(directory.reduce((sum, part) => sum + part.length, 0), 12); ending.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, ...directory, ending]);
}

function docx(text, extra = []) {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body></w:document>`],
    ...extra,
  ]);
}

function pdf(text = '') {
  const stream = text ? `BT /F1 12 Tf 20 180 Td (${text}) Tj ET` : '0.3 g 20 20 40 40 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

function oldDoc(text) {
  const word = Buffer.alloc(1024 + text.length * 2);
  word.writeUInt16LE(0xa5ec, 0); word.writeUInt16LE(0xc1, 2);
  word.writeUInt32LE(1024, 0x18); word.writeUInt32LE(text.length, 0x4c);
  word.writeUInt32LE(0, 0x1a2); word.writeUInt32LE(21, 0x1a6);
  word.write(text, 1024, 'utf16le');
  const table = Buffer.alloc(21);
  table[0] = 2; table.writeUInt32LE(16, 1); table.writeUInt32LE(text.length, 9); table.writeUInt32LE(1024, 15);
  const compound = xlsx.CFB.utils.cfb_new();
  xlsx.CFB.utils.cfb_add(compound, 'WordDocument', word);
  xlsx.CFB.utils.cfb_add(compound, '0Table', table);
  return Buffer.from(xlsx.CFB.write(compound, { type: 'buffer' }));
}

test('PNG JPEG and WebP are image_ready with no invented interpretation', async () => {
  for (const [name, buffer] of [['截图.png', PNG], ['photo.jpg', JPEG], ['photo.webp', WEBP]]) {
    const parsed = await parseAttachment({ buffer, name });
    assert.equal(parsed.status, 'image_ready');
    assert.equal(parsed.kind, 'image');
    assert.equal(parsed.text, '');
    assert.match(parsed.note, /不代表已经理解/);
  }
});

test('rejects oversize files, unsupported formats, spoofed signatures and MIME mismatches', async () => {
  await assert.rejects(parseAttachment({ buffer: Buffer.alloc(MAX_FILE_BYTES + 1), name: 'large.pdf' }), error => error.status === 413);
  for (const [name, buffer, mime] of [
    ['audio.mp3', PNG], ['fake.png', Buffer.from('not png')], ['fake.docx', PNG],
    ['fake.doc', Buffer.from('not a document')], ['file.pdf', PNG], ['picture.png', PNG, 'text/html'],
    ['empty.pdf', Buffer.alloc(0)], ['truncated.png', PNG.subarray(0, 30)],
  ]) await assert.rejects(parseAttachment({ buffer, name, mime }), error => error.status === 400);
  assert.equal((await parseAttachment({ buffer: PNG, name: '..\\../../截图.png' })).name, '截图.png');
});

test('extracts actual DOCX paragraphs and reports 20,000 character truncation', async () => {
  const basic = await parseAttachment({ buffer: docx('客户希望搭建销售工作流，需要审批通知。'), name: '需求.docx' });
  assert.equal(basic.status, 'parsed');
  assert.match(basic.text, /销售工作流/);
  const long = await parseAttachment({ buffer: docx('需求说明'.repeat(6000)), name: 'long.docx' });
  assert.equal(long.text.length, MAX_EXTRACTED_CHARS);
  assert.match(long.note, /20,000/);
  assert.match(long.note, /仅提取/);
});

test('rejects office decompression bombs and macro archives before library parsing', async () => {
  const bomb = docx('正常文字', [['word/huge.xml', Buffer.alloc(10_000_001, 65)]]);
  assert.ok(bomb.length < MAX_FILE_BYTES);
  await assert.rejects(parseAttachment({ buffer: bomb, name: 'bomb.docx' }), error => error.status === 400 && /展开/.test(error.message));
  await assert.rejects(parseAttachment({ buffer: docx('文字', [['word/vbaProject.bin', 'macro']]), name: 'macro.docx' }), error => error.status === 400 && /宏/.test(error.message));
  await assert.rejects(parseAttachment({ buffer: docx('文字'), name: 'renamed.xlsx' }), error => error.status === 400);
  await assert.rejects(parseAttachment({ buffer: docx('文字', [['../escape.xml', 'x']]), name: 'traversal.docx' }), error => error.status === 400);
});

test('extracts real XLSX rows, sheet names and formula cached values without evaluating formulas', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('需求表');
  sheet.addRow(['功能', '数量']);
  sheet.addRow(['自动审批', 8]);
  sheet.addRow(['合计', { formula: 'B2*2', result: 16 }]);
  const parsed = await parseAttachment({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), name: '需求.xlsx' });
  assert.equal(parsed.status, 'parsed');
  assert.match(parsed.text, /需求表/);
  assert.match(parsed.text, /自动审批/);
  assert.match(parsed.text, /2:16/);
  assert.doesNotMatch(parsed.text, /B2\*2/);
});

test('extracts generated genuine binary XLS and DOC files', async () => {
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['项目', '数量'], ['知识助手', 3]]), '旧需求');
  const legacyXls = await parseAttachment({ buffer: xlsx.write(book, { type: 'buffer', bookType: 'biff8' }), name: '旧表格.xls' });
  assert.equal(legacyXls.status, 'parsed');
  assert.match(legacyXls.text, /知识助手/);
  const legacyDoc = await parseAttachment({ buffer: oldDoc('企业知识库助手需求'), name: '旧需求.doc' });
  assert.equal(legacyDoc.status, 'parsed');
  assert.match(legacyDoc.text, /企业知识库助手需求/);
});

test('empty spreadsheets are unreadable instead of claiming the sheet title as document content', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('只有标题没有内容');
  const parsed = await parseAttachment({ buffer: Buffer.from(await book.xlsx.writeBuffer()), name: 'empty.xlsx' });
  assert.equal(parsed.status, 'unreadable');
  assert.equal(parsed.text, '');
});

test('document parsing queue rejects excess work and releases slots after completion', async () => {
  const results = await Promise.allSettled(Array.from({ length: 11 }, () => parseAttachment({ buffer: docx('并行测试'), name: 'test.docx' })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 10);
  assert.equal(results.find(item => item.status === 'rejected').reason.status, 429);
  const after = await parseAttachment({ buffer: docx('恢复解析'), name: 'later.docx' });
  assert.equal(after.status, 'parsed');
});

test('extracts text PDF, but reports unreadable for non-text or broken PDFs', async () => {
  const readable = await parseAttachment({ buffer: pdf('Workflow approval requirements'), name: 'requirements.pdf' });
  assert.equal(readable.status, 'parsed');
  assert.match(readable.text, /Workflow approval requirements/);
  const nonText = await parseAttachment({ buffer: pdf(), name: 'non-text.pdf' });
  assert.equal(nonText.status, 'unreadable');
  assert.equal(nonText.text, '');
  assert.match(nonText.note, /未做 OCR/);
  const broken = await parseAttachment({ buffer: Buffer.from('%PDF-1.4\nnot-a-pdf'), name: 'broken.pdf' });
  assert.equal(broken.status, 'unreadable');
});
