import { NextResponse } from "next/server";
import { getAsyncRun, cancelAsyncRun } from "@/lib/scavenger/opportunities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sc/opportunities/discover/:runId — persisted run state (§10).
// Runs recovery on read: a RUNNING run whose worker died is marked FAILED
// recoverable here, so a stale spinner can never persist across restarts.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const res = await getAsyncRun(runId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
  return NextResponse.json({ run: res.run });
}

// POST /api/sc/opportunities/discover/:runId { action: "cancel" }
export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (body.action !== "cancel") {
    return NextResponse.json({ error: 'unknown action (want "cancel")' }, { status: 400 });
  }
  const res = await cancelAsyncRun(runId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 });
  return NextResponse.json(res);
}
