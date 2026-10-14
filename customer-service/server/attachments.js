import path from 'node:path';
import { fork } from 'node:child_process';

export const MAX_FILE_BYTES = 5_000_000;
export const MAX_EXTRACTED_CHARS = 20_000;
const MAX_UNZIPPED_BYTES = 20_000_000;
const MAX_ENTRY_BYTES = 10_000_000;
const MAX_ZIP_ENTRIES = 2000;
const MAX_IMAGE_PIXELS = 40_000_000;
const PARSE_TIMEOUT_MS = 15_000;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const FORMATS = {
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.pdf': { mime: 'application/pdf', kind: 'document' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document' },
  '.doc': { mime: 'application/msword', kind: 'document' },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document' },
  '.xls': { mime: 'application/vnd.ms-excel', kind: 'document' },
};

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function dimensions(width, height) {
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw fail('图片尺寸无效或过大，请缩小图片后重新上传。');
}

function validatePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) throw fail('图片内容与 PNG 格式不符。');
  let offset = 8;
  let header = false;
  let data = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + length + 12 > buffer.length) throw fail('PNG 图片不完整，请重新上传。');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!header) {
      if (type !== 'IHDR' || length !== 13) throw fail('PNG 图片头无效。');
      dimensions(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12));
      header = true;
    }
    if (type === 'IDAT' && length) data = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length || !data || offset !== buffer.length) throw fail('PNG 图片结构无效。');
      return;
    }
  }
  throw fail('PNG 图片不完整，请重新上传。');
}

function validateJpeg(buffer) {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) {
    throw fail('JPEG 图片格式无效或不完整。');
  }
  let offset = 2;
  let foundSize = false;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset++] !== 0xff) throw fail('JPEG 图片结构无效。');
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xda) {
      if (!foundSize) throw fail('JPEG 图片缺少尺寸信息。');
      return;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) throw fail('JPEG 图片头无效。');
      dimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
      foundSize = true;
    }
    offset += length;
  }
  throw fail('JPEG 图片数据不完整。');
}

function validateWebp(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== buffer.length) {
    throw fail('WebP 图片格式无效或不完整。');
  }
  let offset = 12;
  let image = false;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw fail('WebP 图片数据不完整。');
    if (type === 'VP8X' && size >= 10) {
      dimensions(1 + buffer.readUIntLE(start + 4, 3), 1 + buffer.readUIntLE(start + 7, 3));
    } else if (type === 'VP8L' && size >= 5 && buffer[start] === 0x2f) {
      const bits = buffer.readUInt32LE(start + 1);
      dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      image = true;
    } else if (type === 'VP8 ' && size >= 10 && buffer.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      dimensions(buffer.readUInt16LE(start + 6) & 0x3fff, buffer.readUInt16LE(start + 8) & 0x3fff);
      image = true;
    } else if (type === 'ANIM' || type === 'ANMF') {
      throw fail('请上传静态图片，暂不支持动态 WebP。');
    }
    offset = start + size + (size % 2);
  }
  if (!image || offset !== buffer.length) throw fail('WebP 图片结构无效。');
}

function identify(buffer, name, mime) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw fail('未收到有效文件。');
  if (buffer.byteLength > MAX_FILE_BYTES) throw fail('单个文件不能超过 5MB（5,000,000 字节）。', 413);
  if (!buffer.byteLength) throw fail('不能上传空文件。');
  if (typeof name !== 'string' || !name.trim()) throw fail('文件名无效。');
  const safeName = path.posix.basename(name.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!safeName || safeName.length > 200) throw fail('文件名为空或过长，请重命名后上传。');
  const ext = path.extname(safeName).toLowerCase();
  const format = FORMATS[ext];
  if (!format) throw fail('支持 PNG、JPEG、WebP、PDF、Word（DOC/DOCX）和 Excel（XLS/XLSX）文件。');
  const suppliedMime = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  const generic = ['', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed'];
  if (!generic.includes(suppliedMime) && suppliedMime !== format.mime && !(format.mime === 'image/jpeg' && suppliedMime === 'image/jpg')) {
    throw fail('文件类型与扩展名不一致，请检查后重新上传。');
  }
  if (ext === '.png') validatePng(buffer);
  else if (ext === '.jpg' || ext === '.jpeg') validateJpeg(buffer);
  else if (ext === '.webp') validateWebp(buffer);
  else if (ext === '.pdf' && !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw fail('文件内容不是有效的 PDF。');
  else if ((ext === '.docx' || ext === '.xlsx') && !buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) throw fail('Office 文件格式不符，请重新保存为 DOCX 或 XLSX。');
  else if ((ext === '.doc' || ext === '.xls') && !buffer.subarray(0, 8).equals(OLE_MAGIC)) throw fail('旧版 Office 文件格式不符，请尝试另存为 DOCX 或 XLSX。');
  return { name: safeName, mime: format.mime, kind: format.kind, ext };
}

// Stream every ZIP member before handing the archive to a parser. Do not trust only metadata.
async function inspectOfficeZip(buffer, ext) {
  const { default: yauzl } = await import('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(fail('Office 文件压缩结构损坏。'));
      let entries = 0;
      let declaredBytes = 0;
      let actualBytes = 0;
      let settled = false;
      const names = new Set();
      const stop = error => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on('error', () => stop(fail('Office 文件压缩结构损坏或长度不符。')));
      zip.on('entry', entry => {
        entries++;
        declaredBytes += entry.uncompressedSize;
        if (entries > MAX_ZIP_ENTRIES || entry.uncompressedSize > MAX_ENTRY_BYTES || declaredBytes > MAX_UNZIPPED_BYTES) return stop(fail('文档展开后的内容过大，请拆分后上传。'));
        if (names.has(entry.fileName) || entry.generalPurposeBitFlag & 1) return stop(fail('文档含重复或加密内容，请重新保存后上传。'));
        names.add(entry.fileName);
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (error, stream) => {
          if (error) return stop(fail('Office 文件内容不可读取。'));
          let entryBytes = 0;
          stream.on('data', chunk => {
            entryBytes += chunk.length;
            actualBytes += chunk.length;
            if (entryBytes > MAX_ENTRY_BYTES || actualBytes > MAX_UNZIPPED_BYTES) {
              stream.destroy();
              stop(fail('文档展开后的内容过大，请拆分后上传。'));
            }
          });
          stream.on('error', () => stop(fail('Office 文件内容损坏或长度不符。')));
          stream.on('end', () => { if (!settled) zip.readEntry(); });
        });
      });
      zip.on('end', () => {
        if (settled) return;
        const required = ext === '.docx' ? 'word/document.xml' : 'xl/workbook.xml';
        if (!names.has('[Content_Types].xml') || !names.has(required)) return stop(fail('Office 文件内容与扩展名不一致。'));
        if ([...names].some(name => /vbaProject\.bin$/i.test(name))) return stop(fail('暂不支持包含宏的文件，请另存为不含宏的文档。'));
        settled = true;
        resolve();
      });
      zip.readEntry();
    });
  });
}

function cleanText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function documentResult(text, notes = [], truncated = false) {
  let cleaned = cleanText(text);
  if (cleaned.length > MAX_EXTRACTED_CHARS) {
    cleaned = cleaned.slice(0, MAX_EXTRACTED_CHARS).replace(/[\ud800-\udbff]$/, '');
    truncated = true;
  }
  if (!cleaned) return { text: '', status: 'unreadable', note: [...notes, '未能提取可读文字；扫描件、嵌入图片和图表未做 OCR。请用文字补充或联系人工。'].join(' ') };
  if (truncated) notes.push(`材料超过处理上限，仅提取前 ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} 个字符范围内的内容，请补充未读取的关键需求。`);
  notes.push('已提取文字供需求分析；嵌入图片、扫描文字和图表未做 OCR。');
  return { text: cleaned, status: 'parsed', note: notes.join(' ') };
}

function excelValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (value.richText) return value.richText.map(part => part.text || '').join('');
  if ('result' in value) return excelValue(value.result);
  if ('formula' in value || 'sharedFormula' in value) return '[公式无缓存结果]';
  if (value.text) return String(value.text);
  if (value.error) return String(value.error);
  return '';
}

async function parseDocument(buffer, ext) {
  if (ext === '.docx' || ext === '.xlsx') await inspectOfficeZip(buffer, ext);
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false });
    try {
      const info = await parser.getInfo();
      let text = '';
      let parsedPages = 0;
      for (let page = 1; page <= Math.min(info.total, 50); page++) {
        const result = await parser.getText({ partial: [page], pageJoiner: '' });
        text += `${result.pages?.map(item => item.text).join('\n') ?? result.text}\n`;
        parsedPages++;
        if (text.length > MAX_EXTRACTED_CHARS) break;
      }
      return documentResult(text, parsedPages < info.total ? [`PDF 共 ${info.total} 页，本次仅处理前 ${parsedPages} 页。`] : []);
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.docx') {
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return documentResult(result.value, result.messages.length ? ['文档包含部分无法完整解析的元素。'] : []);
  }
  if (ext === '.doc') {
    const { default: WordExtractor } = await import('word-extractor');
    const doc = await new WordExtractor().extract(buffer);
    return documentResult(doc.getBody(), ['旧版 Word 仅提取正文。']);
  }
  if (ext === '.xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer, { ignoreNodes: ['drawing', 'picture', 'extLst'] });
    let text = '';
    let truncated = false;
    let hasCellContent = false;
    for (const sheet of workbook.worksheets) {
      text += `[工作表：${sheet.name}]\n`;
      for (const row of sheet.getRows(1, Math.min(sheet.rowCount, 5000)) || []) {
        const cells = [];
        row.eachCell({ includeEmpty: false }, (cell, column) => {
          if (column > 200) { truncated = true; return; }
          const value = excelValue(cell.value);
          if (value) { cells.push(`${column}:${value}`); hasCellContent = true; }
        });
        if (cells.length) text += `${row.number} | ${cells.join(' | ')}\n`;
        if (text.length > MAX_EXTRACTED_CHARS) break;
      }
      if (sheet.rowCount > 5000) truncated = true;
      if (text.length > MAX_EXTRACTED_CHARS) { truncated = true; break; }
    }
    return documentResult(hasCellContent ? text : '', ['表格最多处理每表前 5000 行、200 列，公式仅使用文件中已有缓存结果。'], truncated);
  }
  if (ext === '.xls') {
    const { createRequire } = await import('node:module');
    const xlsx = createRequire(import.meta.url)('xlsx');
    const workbook = xlsx.read(buffer, { type: 'buffer', sheetRows: 5000, cellFormula: false, cellHTML: false, cellNF: false, bookVBA: false, dense: true });
    let text = '';
    let truncated = false;
    let hasCellContent = false;
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      const ref = sheet['!ref'];
      if (!ref) continue;
      const range = xlsx.utils.decode_range(ref);
      const rows = sheet['!data'] || sheet;
      text += `[工作表：${name}]\n`;
      for (let r = range.s.r; r <= Math.min(range.e.r, 4999); r++) {
        const cells = [];
        for (let c = range.s.c; c <= Math.min(range.e.c, 199); c++) {
          const cell = rows[r]?.[c];
          if (cell && cell.v != null && String(cell.w ?? cell.v)) {
            cells.push(`${c + 1}:${String(cell.w ?? cell.v)}`);
            hasCellContent = true;
          }
        }
        if (cells.length) text += `${r + 1} | ${cells.join(' | ')}\n`;
        if (text.length > MAX_EXTRACTED_CHARS) break;
      }
      if (sheet['!fullref'] || range.e.r >= 5000 || range.e.c >= 200) truncated = true;
      if (text.length > MAX_EXTRACTED_CHARS) { truncated = true; break; }
    }
    return documentResult(hasCellContent ? text : '', ['旧版 Excel 最多处理每表前 5000 行、200 列，公式仅使用文件中已有缓存结果。'], truncated);
  }
  throw fail('不支持该文档格式。');
}

let activeParsers = 0;
const waitingParsers = [];

async function isolatedDocument(buffer, ext) {
  if (activeParsers >= 2) {
    if (waitingParsers.length >= 8) throw fail('当前处理的附件较多，请稍后重试。', 429);
    await new Promise(resolve => waitingParsers.push(resolve));
  } else activeParsers++;
  try {
    return await new Promise((resolve, reject) => {
      const parser = fork(new URL(import.meta.url), ['--attachment-parser'], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        // Isolate native parser exits and discard inherited host/test-only flags.
        execArgv: ['--max-old-space-size=256'],
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      let completed = false;
      const finish = (value, error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        parser.kill();
        if (error) reject(error); else resolve(value);
      };
      const timeout = setTimeout(() => finish({ text: '', status: 'unreadable', note: '材料解析超时，请拆分文件、用文字补充需求或联系人工。' }), PARSE_TIMEOUT_MS);
      parser.once('message', message => message.error ? finish(null, fail(message.error, message.status)) : finish(message.result));
      parser.once('error', () => finish({ text: '', status: 'unreadable', note: '材料无法安全解析，请重新保存、用文字补充需求或联系人工。' }));
      parser.once('exit', () => { if (!completed) finish({ text: '', status: 'unreadable', note: '材料未能完成解析，请用文字补充需求或联系人工。' }); });
      parser.send({ buffer, ext });
    });
  } finally {
    const next = waitingParsers.shift();
    if (next) next(); else activeParsers--;
  }
}

export async function parseAttachment({ buffer, name, mime } = {}) {
  const source = buffer instanceof Uint8Array && !Buffer.isBuffer(buffer) ? Buffer.from(buffer) : buffer;
  const { ext, ...meta } = identify(source, name, mime);
  if (meta.kind === 'image') return { ...meta, text: '', status: 'image_ready', note: '图片格式已校验，内容需由支持图片的模型读取；上传成功不代表已经理解。' };
  const result = await isolatedDocument(source, ext);
  return { ...meta, ...result };
}

if (process.argv.includes('--attachment-parser') && process.send) {
  process.once('message', async ({ buffer, ext }) => {
    try {
      const result = await parseDocument(Buffer.from(buffer), ext);
      process.send({ result });
    } catch (error) {
      if (error.status) process.send({ error: error.message, status: error.status });
      else process.send({ result: { text: '', status: 'unreadable', note: '无法提取材料文字，文件可能损坏、加密或不受支持。请重新保存、用文字补充需求或联系人工。' } });
    }
  });
}
