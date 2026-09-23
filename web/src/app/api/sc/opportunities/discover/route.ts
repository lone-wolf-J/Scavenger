import { NextResponse } from "next/server";
import { runDiscovery, getDiscoveryRuns, startDiscoveryRun, listAsyncRuns } from "@/lib/scavenger/opportunities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/sc/opportunities/discover — async persisted runs (§7).
// { profileIds, maxAgeDays?, maxQueries?, providers?, refresh? }
// Returns immediately with { runId, status: "QUEUED" }; the client polls
// GET .../discover/:runId. A synchronous `mode: "sync"` escape hatch keeps
// the old behavior for scripts/tests that want one response.
// WARNING: sync mode holds the HTTP request for the whole provider scan;
// prefer async for interactive use.
export async function POST(req: Request) {
  let body: {
    profileIds?: string[];
    maxAgeDays?: number;
    maxQueries?: number;
    providers?: string[];
    refresh?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (body.profileIds !== undefined && !Array.isArray(body.profileIds)) {
    return NextResponse.json({ error: "profileIds must be an array" }, { status: 400 });
  }
  const summon = {
    profileIds: body.profileIds,
    maxAgeDays: typeof body.maxAgeDays === "number" ? body.maxAgeDays : undefined,
    maxQueries: typeof body.maxQueries === "number" ? body.maxQueries : undefined,
    providers: Array.isArray(body.providers) ? body.providers.filter((x): x is string => typeof x === "string") : undefined,
    refresh: body.refresh === true,
  };
  if ((body as { mode?: string }).mode === "sync") {
    const res = await runDiscovery(summon);
    if (!res.ok) return NextResponse.json({ error: res.error, code: "code" in res ? res.code : undefined }, { status: 422 });
    return NextResponse.json(res.result);
  }
  const res = await startDiscoveryRun(summon);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 422 });
  return NextResponse.json(res, { status: 202 });
}

export async function GET() {
  return NextResponse.json({ runs: await getDiscoveryRuns(), asyncRuns: await listAsyncRuns() });
}
