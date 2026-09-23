import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractDocumentText, extractPdfBuiltin, unzipEntries } from '../lib/resume-io.mjs';

// Build a minimal stored (method-0) ZIP independently of the reader.
function makeStoredZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const data = enc.encode(text);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt16LE(0, 14);
    lh.writeUInt32LE(0, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, Buffer.from(nameB), Buffer.from(data));
    central.push({ nameB, len: data.length, offset });
    offset += 30 + nameB.length + data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  const cparts = [];
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt16LE(0, 16);
    ch.writeUInt32LE(c.len, 20);
    ch.writeUInt32LE(c.len, 24);
    ch.writeUInt16LE(c.nameB.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(c.offset, 42);
    cparts.push(ch, Buffer.from(c.nameB));
    centralSize += 46 + c.nameB.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, ...cparts, end]);
}

const DOC_XML = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Jane Doe</w:t></w:r></w:p><w:p><w:r><w:t>Senior HR Manager</w:t></w:r><w:r><w:t> — Acme</w:t></w:r></w:p></w:body></w:document>`;

// Minimal born-digital PDF: one FlateDecode content stream with Tj/TJ text.
function makePdf() {
  const text = 'BT /F1 12 Tf 72 720 Td (Jane Doe) Tj (Senior HR Manager) Tj ET BT [(Workday) 50 (Greenhouse)] TJ ET';
  const comp = deflateRawSync(Buffer.from(text, 'latin1'));
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj',
    `4 0 obj<</Length ${comp.length}/Filter/FlateDecode>>stream\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) {
    if (o.endsWith('stream\n')) {
      offsets.push(pdf.length);
      pdf += o;
      pdf += comp.toString('latin1') + '\nendstream\nendobj\n';
    } else {
      offsets.push(pdf.length);
      pdf += o + '\n';
    }
  }
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map((x) => String(x).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<</Size 5/Root 1 0 R>>\nstartxref\n${pdf.length}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

describe('resume-io', () => {
  it('reads txt/md buffers fully', () => {
    const r = extractDocumentText({ buffer: Buffer.from('Jane Doe\nHR Director'), ext: '.txt' });
    assert.equal(r.quality, 'full');
    assert.ok(r.text.includes('HR Director'));
  });
  it('extracts docx paragraphs without a zip dependency', () => {
    const buf = makeStoredZip({ 'word/document.xml': DOC_XML, '[Content_Types].xml': '<x/>' });
    const entries = unzipEntries(buf);
    assert.ok(entries.has('word/document.xml'));
    const r = extractDocumentText({ buffer: buf, ext: '.docx' });
    assert.equal(r.quality, 'full');
    assert.ok(r.text.includes('Jane Doe'));
    assert.ok(r.text.includes('Senior HR Manager — Acme'));
  });
  it('reports corrupt docx honestly', () => {
    const r = extractDocumentText({ buffer: Buffer.from('not a zip'), ext: '.docx' });
    assert.equal(r.quality, 'unparseable');
    assert.ok(r.warnings.length > 0);
  });
  it('parses born-digital PDF text (builtin)', () => {
    const r = extractPdfBuiltin(makePdf());
    assert.equal(r.quality, 'partial');
    assert.ok(r.text.includes('Jane Doe'), r.text);
    assert.ok(r.text.includes('Senior HR Manager'), r.text);
    assert.ok(r.text.includes('Workday') && r.text.includes('Greenhouse'), r.text);
  });
  it('reports encrypted/image PDFs as unparseable, never hallucinated', () => {
    const enc = extractPdfBuiltin(Buffer.from('%PDF-1.4 /Encrypt <<>> BT (x) Tj ET', 'latin1'));
    assert.equal(enc.quality, 'unparseable');
    const empty = extractPdfBuiltin(Buffer.from('%PDF-1.4 hello world', 'latin1'));
    assert.equal(empty.quality, 'unparseable');
    assert.equal(empty.text, '');
  });
  it('uses an injected poppler-style extractor when provided', () => {
    const r = extractDocumentText({ path: '/fake/cv.pdf', buffer: Buffer.from('%PDF'), ext: '.pdf', pdfExtractor: { extract: () => 'POPPLER TEXT' } });
    assert.equal(r.text, 'POPPLER TEXT');
    assert.equal(r.quality, 'full');
  });
  it('rejects legacy formats with a conversion hint, never throws', () => {
    for (const ext of ['.doc', '.odt', '.rtf', '.png', '.xyz']) {
      const r = extractDocumentText({ buffer: Buffer.from('x'), ext });
      assert.equal(r.quality, 'unparseable', ext);
    }
    assert.equal(extractDocumentText({}).quality, 'unparseable');
  });
});
