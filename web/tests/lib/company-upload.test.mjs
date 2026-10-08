import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  parseCompanyWorkbook,
  MAX_UPLOAD_COMPANIES,
} from "../../src/lib/company-upload.mjs";

function workbookBuffer(rows) {
  const wb = XLSX.utils.book_new();
  wb.SheetNames.push("Companies");
  wb.Sheets.Companies = XLSX.utils.aoa_to_sheet(rows);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

test("header row, blanks and index numbers are skipped", () => {
  const buf = workbookBuffer([
    ["Company"],
    ["Acme Corp"],
    [""],
    ["Globex"],
    [null],
    ["  Initech  "],
  ]);
  const r = parseCompanyWorkbook(buf);
  assert.deepEqual(r.companies, ["Acme Corp", "Globex", "Initech"]);
  assert.equal(r.rowsSeen, 6);
  assert.equal(r.capped, false);
});

test("numeric first column is treated as an index, not names", () => {
  const buf = workbookBuffer([["#"], [1], [2], ["Umbrella"]]);
  const r = parseCompanyWorkbook(buf);
  assert.deepEqual(r.companies, ["Umbrella"]);
});

test("dedupes case-insensitively and caps at 100", () => {
  const rows = [["Company"]];
  for (let i = 1; i <= 105; i++) rows.push([`Company${i}`]);
  rows.push(["company1"]);
  const r = parseCompanyWorkbook(Buffer.from(XLSX.write(
    (() => { const wb = XLSX.utils.book_new(); wb.SheetNames.push("S"); wb.Sheets.S = XLSX.utils.aoa_to_sheet(rows); return wb; })(),
    { type: "buffer", bookType: "xlsx" },
  )));
  assert.equal(r.companies.length, MAX_UPLOAD_COMPANIES);
  assert.equal(r.capped, true);
});

test("oversize files and empty sheets fail loudly", () => {
  assert.throws(() => parseCompanyWorkbook(Buffer.alloc(10), { maxBytes: 5 }), (e) => e.code === "TOO_LARGE");
  const empty = workbookBuffer([]);
  assert.throws(() => parseCompanyWorkbook(empty), (e) => e.code === "EMPTY");
});
