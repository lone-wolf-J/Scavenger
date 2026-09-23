import { NextResponse } from "next/server";
import { ingestDocument } from "@/lib/scavenger/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB — resumes are small; refuse dumps

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "multipart form required" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file field required (.txt, .md, .pdf, .docx)" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large (over 5MB)" }, { status: 413 });
  const bytes = Buffer.from(await file.arrayBuffer());
  const res = await ingestDocument(file.name, bytes);
  if (!res.ok) {
    // Honest failure states (§21): unparseable is reported, never faked.
    return NextResponse.json({ error: res.error }, { status: 422 });
  }
  // Signals go back to the browser for the review screen; the server keeps
  // the draft (metadata + signals) until confirm or discard.
  return NextResponse.json(res);
}
