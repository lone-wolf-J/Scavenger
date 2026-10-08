import * as XLSX from "xlsx";

// Excel upload parsing for Target Companies — workbook bytes in, company
// names out. Contract: one company per row, FIRST column. A header row
// (company/clients/name/…) is skipped, pure numbers are skipped, and the
// surviving names run through the same chat-friendly cleanup as typed input
// (dedupe, cap) so upload and typing converge on one list shape.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_COMPANIES = 100;

const HEADER_RE = /^(compan(y|ies)|client(s)?|names?|organizations?|organisations?|employers?|accounts?|targets?|firms?)\b/i;

/**
 * @param {Buffer|Uint8Array|ArrayBuffer} bytes - workbook file bytes
 * @param {{maxCompanies?: number, maxBytes?: number}} [opts]
 * @returns {{companies: string[], dropped: string[], capped: boolean, rowsSeen: number}}
 */
export function parseCompanyWorkbook(bytes, opts = {}) {
  const maxCompanies = opts.maxCompanies ?? MAX_UPLOAD_COMPANIES;
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const buf = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from(bytes);
  if (buf.length > maxBytes) {
    throw Object.assign(new Error(`file too large (${buf.length} bytes, max ${maxBytes})`), { code: "TOO_LARGE" });
  }
  let wb;
  try {
    wb = XLSX.read(buf, { type: "buffer" });
  } catch (e) {
    throw Object.assign(new Error(`could not read workbook: ${e?.message || e}`), { code: "UNREADABLE" });
  }
  const sheetName = wb.SheetNames?.[0];
  if (!sheetName) throw Object.assign(new Error("workbook has no sheets"), { code: "EMPTY" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
  if (!rows.length) throw Object.assign(new Error("first sheet is empty"), { code: "EMPTY" });

  const rawNames = [];
  rows.forEach((row, i) => {
    const cell = Array.isArray(row) ? row[0] : null;
    if (cell == null) return;
    const text = String(cell).trim();
    if (!text) return;
    if (i === 0 && HEADER_RE.test(text)) return; // header row
    if (/^[\d.,\s]+$/.test(text)) return; // index/count column, not a name
    rawNames.push(text);
  });

  // Same cleanup as typed input (quotes, bullets, dedupe, cap).
  const seen = new Set();
  const companies = [];
  const dropped = [];
  for (const raw of rawNames) {
    const name = raw
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .replace(/^(?:[-*•\d]+\s*[.)]\s*)+/, "")
      .trim();
    if (!name || name.length < 2) {
      dropped.push(raw);
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (companies.length >= maxCompanies) {
      dropped.push(name);
      continue;
    }
    companies.push(name);
  }
  return { companies, dropped, capped: dropped.length > 0, rowsSeen: rows.length };
}
