import { NextResponse } from "next/server";
import { getDraft, confirmDraft } from "@/lib/scavenger/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const draftId = searchParams.get("draft");
  if (!draftId) return NextResponse.json({ error: "draft param required" }, { status: 400 });
  const draft = await getDraft(draftId);
  if (!draft) return NextResponse.json({ error: "draft not found" }, { status: 404 });
  return NextResponse.json({ draft });
}

export async function POST(req: Request) {
  let body: { draftId?: string; corrections?: unknown[]; adopt?: string[]; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.draftId) return NextResponse.json({ error: "draftId required" }, { status: 400 });
  const res = await confirmDraft(body.draftId, {
    corrections: Array.isArray(body.corrections) ? body.corrections : [],
    adopt: Array.isArray(body.adopt) ? body.adopt.filter((x): x is string => typeof x === "string") : [],
    name: typeof body.name === "string" ? body.name : undefined,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
  return NextResponse.json(res);
}
