// Resume ingestion abstraction — format-neutral document → text.
//
// extractDocumentText({path?, buffer?, ext?}) returns
// { text, format, quality: 'full'|'partial'|'unparseable', warnings[] }.
// Never throws for bad input; unparseable documents explain themselves.
//
// Ladders (zero new dependencies):
//   txt/md/tex → direct read (full).
//   pdf → poppler pdftotext when present (full) → built-in born-digital
//     parser (partial: WinAnsi/UTF-16 strings in Tj/TJ; scanned or encrypted
//     PDFs report unparseable, never OCR-hallucinated text).
//   docx → built-in minimal unzip + word/document.xml w:t text (full for
//     standard Word output; legacy .doc/.odt/.rtf stay unsupported with a
//     conversion hint, mirroring intake.mjs).

import { readFileSync } from 'fs';
import { inflateRawSync } from 'zlib';

export const SUPPORTED_EXTS = new Set(['.txt', '.md', '.tex', '.pdf', '.docx']);

function unparseable(format, warnings) {
  return { text: '', format, quality: 'unparseable', warnings };
}

// ---------- plain text ----------

function extractTextBuffer(buffer) {
  let text = buffer.toString('utf-8');
  if (text.includes('�') && !buffer.includes(0)) {
    // Try latin1 as a fallback for legacy-encoded resumes.
    const latin = buffer.toString('latin1');
    if (latin.length >= text.length) text = latin;
  }
  return text;
}

// ---------- minimal ZIP reader (for .docx) ----------

function readUInt16LE(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function readUInt32LE(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) + buf[off + 3] * 0x1000000) >>> 0;
}

/**
 * List + decompress entries of a ZIP buffer (stored + deflate only).
 * Returns Map<name, Buffer>. Throws ZipError on structural problems.
 */
export function unzipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw zipError('too small for a ZIP archive');
  // Locate EOCD (search last 64KB + 22).
  let eocd = -1;
  const start = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (readUInt32LE(buffer, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw zipError('end-of-central-directory not found');
  const entries = readUInt16LE(buffer, eocd + 10);
  let off = readUInt32LE(buffer, eocd + 16);
  const out = new Map();
  for (let n = 0; n < entries; n++) {
    if (readUInt32LE(buffer, off) !== 0x02014b50) throw zipError(`bad central-directory signature at entry ${n}`);
    const method = readUInt16LE(buffer, off + 10);
    const flags = readUInt16LE(buffer, off + 8);
    if (flags & 0x1) throw zipError('encrypted ZIP entries are unsupported');
    const compSize = readUInt32LE(buffer, off + 20);
    const nameLen = readUInt16LE(buffer, off + 28);
    const extraLen = readUInt16LE(buffer, off + 30);
    const commentLen = readUInt16LE(buffer, off + 32);
    const headerOff = readUInt32LE(buffer, off + 42);
    const name = buffer.toString('utf-8', off + 46, off + 46 + nameLen);
    if (readUInt32LE(buffer, headerOff) !== 0x04034b50) throw zipError(`bad local header for "${name}"`);
    const lhNameLen = readUInt16LE(buffer, headerOff + 26);
    const lhExtraLen = readUInt16LE(buffer, headerOff + 28);
    const dataOff = headerOff + 30 + lhNameLen + lhExtraLen;
    const comp = buffer.subarray(dataOff, dataOff + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = inflateRawSync(comp);
    else throw zipError(`unsupported compression method ${method} in "${name}"`);
    out.set(name, data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function zipError(message) {
  const err = new Error(message);
  err.code = 'ZIP_PARSE';
  return err;
}

function extractDocxText(buffer) {
  let entries;
  try {
    entries = unzipEntries(buffer);
  } catch (err) {
    return { text: '', quality: 'unparseable', warnings: [`docx unzip failed: ${err.message}`] };
  }
  const doc = entries.get('word/document.xml');
  if (!doc) return { text: '', quality: 'unparseable', warnings: ['docx missing word/document.xml'] };
  const xml = doc.toString('utf-8');
  // Paragraphs first (w:p), then runs (w:t) inside; tabs/breaks → spaces.
  const paras = [];
  const pRe = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let pm;
  let found = false;
  while ((pm = pRe.exec(xml)) !== null) {
    found = true;
    const texts = [];
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tm;
    while ((tm = tRe.exec(pm[0])) !== null) texts.push(decodeXml(tm[1]));
    const para = texts.join('').replace(/\s+/g, ' ').trim();
    if (para) paras.push(para);
  }
  if (!found) return { text: '', quality: 'unparseable', warnings: ['docx has no readable paragraphs'] };
  return { text: paras.join('\n'), quality: 'full', warnings: [] };
}

function decodeXml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

// ---------- minimal born-digital PDF text ----------

const WIN_ANSI_EXTRA = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x91: '‘', 0x92: '’',
  0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™',
  0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodePdfBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  return [...bytes].map((b) => (b < 0x80 ? String.fromCharCode(b) : WIN_ANSI_EXTRA[b] || `�`)).join('');
}

function unescapePdfLiteral(s) {
  return s.replace(/\\([nrtbf()\\]|$)|\\([0-7]{1,3})/g, (m, esc, oct) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\', '': '' }[esc] ?? '';
  });
}

/**
 * Best-effort text from a born-digital PDF buffer. Handles FlateDecode
 * content streams + literal/hex strings shown by Tj/TJ. Returns
 * { text, quality: 'partial', warnings[] } or unparseable for encrypted /
 * image-only documents.
 */
export function extractPdfBuiltin(buffer) {
  const warnings = [];
  const latin = buffer.toString('latin1');
  if (/\/Encrypt/i.test(latin)) return { text: '', quality: 'unparseable', warnings: ['PDF is encrypted'] };
  // Collect stream objects; try FlateDecode on each.
  const streams = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let sm;
  while ((sm = streamRe.exec(latin)) !== null) streams.push(sm[1]);
  const chunks = [];
  for (const raw of streams) {
    let bytes = Buffer.from(raw, 'latin1');
    // Strip the trailing newline that belongs to the stream framing.
    if (bytes.length && (bytes[bytes.length - 1] === 0x0a)) bytes = bytes.subarray(0, -1);
    if (bytes.length && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, -1);
    try {
      const inflated = inflateRawSync(bytes);
      chunks.push(inflated.toString('latin1'));
    } catch {
      // Not flated (or predictor-encoded) — try raw content.
      if (/BT[\s\S]{0,4000}?(Tj|TJ)/.test(bytes.toString('latin1').slice(0, 8000))) chunks.push(bytes.toString('latin1'));
    }
  }
  const content = chunks.join('\n');
  // Tj strings and TJ arrays.
  const parts = [];
  const tjRe = /\((?:\\.|[^\\()])*\)\s*Tj|<([0-9a-fA-F\s]+)>\s*Tj|\[([\s\S]*?)\]\s*TJ/g;
  let m;
  while ((m = tjRe.exec(content)) !== null) {
    if (m[0].startsWith('(')) {
      parts.push(decodePdfBytes(Buffer.from(unescapePdfLiteral(m[0].slice(1, m[0].lastIndexOf(')'))), 'latin1')));
    } else if (m[1] != null) {
      const hex = m[1].replace(/\s+/g, '');
      const bytes = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
      parts.push(decodePdfBytes(bytes));
    } else if (m[2] != null) {
      const inner = m[2];
      const litRe = /\((?:\\.|[^\\()])*\)|<([0-9a-fA-F\s]+)>/g;
      let im;
      while ((im = litRe.exec(inner)) !== null) {
        if (im[0].startsWith('(')) {
          parts.push(decodePdfBytes(Buffer.from(unescapePdfLiteral(im[0].slice(1, -1)), 'latin1')));
        } else {
          const hex = (im[1] || '').replace(/\s+/g, '');
          parts.push(decodePdfBytes(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex')));
        }
      }
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) {
    const imageOnly = /\/Subtype\s*\/Image/i.test(latin) && !/\/Font/i.test(latin);
    return {
      text: '', quality: 'unparseable',
      warnings: [imageOnly ? 'PDF appears image-only (no text layer, no fonts)' : 'no extractable text found (unsupported encoding or scanned PDF)'],
    };
  }
  if (/�/.test(text)) warnings.push('some characters undecodable (non-WinAnsi encoding without ToUnicode map)');
  return { text, quality: 'partial', warnings };
}

// ---------- dispatcher ----------

/**
 * Extract text from a resume-family document.
 * @param {{path?: string, buffer?: Buffer, ext?: string, pdfExtractor?: object|null}} opts
 * pdfExtractor: { extract(path) } — e.g. intake.mjs's poppler ladder via
 * detectPdfExtractor(). Omit/null to use the built-in PDF parser.
 */
export function extractDocumentText({ path, buffer, ext = '', pdfExtractor = 'auto' } = {}) {
  let buf = buffer;
  if (!buf && path) {
    try {
      buf = readFileSync(path);
    } catch (err) {
      return { text: '', format: 'unknown', quality: 'unparseable', warnings: [`cannot read file: ${err.message}`] };
    }
  }
  if (!buf) return { text: '', format: 'unknown', quality: 'unparseable', warnings: ['no path or buffer provided'] };
  const extension = String(ext || (path ? path.slice(path.lastIndexOf('.')) : '')).toLowerCase();
  if (['.txt', '.md', '.tex'].includes(extension)) {
    return { text: extractTextBuffer(buf), format: 'text', quality: 'full', warnings: [] };
  }
  if (extension === '.docx') {
    const r = extractDocxText(buf);
    return { text: r.text, format: 'docx', quality: r.quality, warnings: r.warnings };
  }
  if (extension === '.pdf') {
    if (pdfExtractor && typeof pdfExtractor.extract === 'function' && path) {
      try {
        return { text: pdfExtractor.extract(path), format: 'pdf', quality: 'full', warnings: [] };
      } catch (err) {
        return { text: '', format: 'pdf', quality: 'unparseable', warnings: [`PDF extractor failed: ${err.message}`] };
      }
    }
    const r = extractPdfBuiltin(buf);
    return { text: r.text, format: 'pdf', quality: r.quality, warnings: r.warnings };
  }
  if (['.doc', '.odt', '.rtf'].includes(extension)) {
    return { text: '', format: extension.slice(1), quality: 'unparseable', warnings: [`${extension} is unsupported — export to PDF or .txt first`] };
  }
  return { text: '', format: 'unknown', quality: 'unparseable', warnings: [`unrecognized extension ${extension || '(none)'}`] };
}
