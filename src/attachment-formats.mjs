import { inflateRawSync } from 'node:zlib';
import { textExtensions, checkAttachment } from '../public/attachment-policy.js';

// Inspect container directories and bounded metadata only; never extract or execute a document.
function zipEntries(data) {
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50 || end + 22 + data.readUInt16LE(end + 20) !== data.length) throw Error('无效的 Office ZIP 容器');
  const count = data.readUInt16LE(end + 10), start = data.readUInt32LE(end + 16), size = data.readUInt32LE(end + 12);
  if (data.readUInt32LE(end + 4) || count !== data.readUInt16LE(end + 8) || count > 10000 || start + size !== end) throw Error('不支持此 Office 容器');
  const entries = new Map(); let cursor = start;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) throw Error('损坏的 Office 目录');
    const length = data.readUInt16LE(cursor + 28), extra = data.readUInt16LE(cursor + 30), comment = data.readUInt16LE(cursor + 32);
    if (cursor + 46 + length + extra + comment > end) throw Error('损坏的 Office 目录');
    const name = data.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    const entry = { offset: data.readUInt32LE(cursor + 42), compressed: data.readUInt32LE(cursor + 20), size: data.readUInt32LE(cursor + 24), method: data.readUInt16LE(cursor + 10) };
    if (entries.has(name) || name.includes('..') || name.includes('\\') || name.startsWith('/') || data.readUInt16LE(cursor + 8) & 1 || ![0, 8].includes(entry.method)) throw Error('不支持此 Office 条目');
    const local = entry.offset;
    if (local + 30 > start || data.readUInt32LE(local) !== 0x04034b50) throw Error('损坏的 Office 条目');
    const localNameLength = data.readUInt16LE(local + 26);
    entry.begin = local + 30 + localNameLength + data.readUInt16LE(local + 28);
    if (entry.begin + entry.compressed > start || data.subarray(local + 30, local + 30 + localNameLength).toString() !== name || data.readUInt16LE(local + 8) !== entry.method || data.readUInt16LE(local + 6) & 1) throw Error('Office 条目不匹配');
    entries.set(name, entry); cursor += 46 + length + extra + comment;
  }
  if (cursor !== end) throw Error('损坏的 Office 目录');
  return entries;
}
function officeZip(data, ext) {
  const entries = zipEntries(data), entry = entries.get('[Content_Types].xml');
  if (!entry || !entries.has('_rels/.rels') || entry.size > 1024 * 1024 || [...entries.keys()].some(name => /vbaproject|activex|macrosheets/i.test(name))) throw Error('不支持宏或无效 Office 文档');
  const raw = data.subarray(entry.begin, entry.begin + entry.compressed);
  const xml = (entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: 1024 * 1024 }) : raw).toString('utf8');
  const [main, type] = { docx: ['word/document.xml', 'wordprocessingml.document'], xlsx: ['xl/workbook.xml', 'spreadsheetml.sheet'], pptx: ['ppt/presentation.xml', 'presentationml.presentation'] }[ext];
  if (Buffer.byteLength(xml) !== entry.size || /macroEnabled|vbaProject|<!DOCTYPE|<!ENTITY/i.test(xml) || !entries.has(main) || !xml.includes(`application/vnd.openxmlformats-officedocument.${type}.main+xml`)) throw Error('Office 文档类型与后缀不匹配');
}
function officeCompound(data, ext) {
  if (data.length < 512 || data.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1' || data.readUInt16LE(28) !== 0xfffe) throw Error('无效的旧版 Office 容器');
  const shift = data.readUInt16LE(30), sector = 2 ** shift;
  if (![9, 12].includes(shift) || data.length % sector) throw Error('损坏的旧版 Office 容器');
  const fatCount = data.readUInt32LE(44);
  // Small classic files fit the header DIFAT. Extended containers are rejected conservatively.
  if (!fatCount || fatCount > 109) throw Error('此旧版 Office 容器过于复杂，请另存为新版格式');
  const fats = [];
  for (let i = 0; i < fatCount; i++) {
    const offset = (data.readUInt32LE(76 + i * 4) + 1) * sector;
    if (offset + sector > data.length) throw Error('损坏的 Office 分配表');
    fats.push(data.subarray(offset, offset + sector));
  }
  const fat = Buffer.concat(fats), seen = new Set(), names = [];
  let id = data.readUInt32LE(48);
  while (id !== 0xfffffffe) {
    const offset = (id + 1) * sector;
    if (seen.has(id) || offset + sector > data.length || id * 4 + 4 > fat.length) throw Error('损坏的 Office 目录链');
    seen.add(id);
    for (let p = offset; p < offset + sector; p += 128) {
      const length = data.readUInt16LE(p + 64), type = data[p + 66];
      if (![1, 2, 5].includes(type)) continue;
      if (length < 2 || length > 64 || length % 2) throw Error('损坏的 Office 目录名');
      names.push(data.subarray(p, p + length - 2).toString('utf16le'));
    }
    id = fat.readUInt32LE(id * 4);
  }
  const required = { doc: ['WordDocument'], xls: ['Workbook', 'Book'], ppt: ['PowerPoint Document'] }[ext];
  if (!required.some(name => names.includes(name)) || names.some(name => /^(VBA|_VBA_PROJECT(?:_CUR)?|Macros|EncryptedPackage)$/i.test(name))) throw Error('旧版 Office 类型不匹配、含宏或已加密');
}
export function validateAttachment(name, data) {
  const kind = checkAttachment(name, data.length), ext = name.split('.').pop().toLowerCase();
  if (kind === 'image') {
    const valid = ext === 'png' ? data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : ['jpg', 'jpeg'].includes(ext) ? data.subarray(0, 3).toString('hex') === 'ffd8ff' : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
    if (!valid) throw Error('图片内容与格式不匹配');
  } else if (textExtensions.has(ext)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw Error('文本文件必须是有效 UTF-8 编码'); }
    if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw Error('文本文件包含二进制控制字节');
  } else if (ext === 'pdf') {
    if (!/^%PDF-\d\.\d(?:\r|\n)/.test(data.subarray(0, 16).toString()) || !/%%EOF\s*$/.test(data.subarray(-1024).toString())) throw Error('无效的 PDF 文件');
  } else if (ext.endsWith('x')) officeZip(data, ext);
  else officeCompound(data, ext);
  return kind;
}
