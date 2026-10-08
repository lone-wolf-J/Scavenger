import { NextResponse } from "next/server";
import { parseCompanyWorkbook, MAX_UPLOAD_BYTES } from "@/lib/company-upload.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_EXT = [".xlsx", ".xls", ".csv"];

// POST /api/sc/companies/upload — multipart form with a `file` field.
// Parses company names (first column, one per row, up to 100) without
// crawling anything; the client feeds the list into the normal crawl flow.
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form with a file field" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
    return NextResponse.json({ error: "no file uploaded (field name: file)" }, { status: 400 });
  }
  const f = file as unknown as File;
  const lower = (f.name || "").toLowerCase();
  if (!ALLOWED_EXT.some((ext) => lower.endsWith(ext))) {
    return NextResponse.json({ error: "expected an Excel file (.xlsx, .xls) or .csv" }, { status: 400 });
  }
  if (f.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: `file too large (${f.size} bytes, max ${MAX_UPLOAD_BYTES})` }, { status: 413 });
  }
  let parsed;
  try {
    parsed = parseCompanyWorkbook(Buffer.from(await f.arrayBuffer()));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const status = err.code === "TOO_LARGE" ? 413 : 422;
    return NextResponse.json({ error: err.message || "could not parse workbook" }, { status });
  }
  if (!parsed.companies.length) {
    return NextResponse.json({ error: "no company names found — put one per row in the first column", ...parsed }, { status: 422 });
  }
  return NextResponse.json(parsed);
}
