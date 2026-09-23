import { NextResponse } from "next/server";
import { getOpportunities, getJobDetail, recordJobEvent } from "@/lib/scavenger/opportunities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseIds(sp: URLSearchParams): string[] {
  const raw = sp.get("profiles") || sp.get("profileIds") || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("job");
  if (jobId) {
    const detail = await getJobDetail(jobId, parseIds(searchParams));
    if (!detail.ok) return NextResponse.json({ error: detail.error }, { status: 404 });
    return NextResponse.json(detail);
  }
  const minScore = searchParams.get("minScore");
  const filters: Record<string, unknown> = {};
  for (const k of ["profileId", "seniority", "location", "workplace", "employment", "company", "source", "lifecycle", "provider"]) {
    const v = searchParams.get(k);
    if (v) filters[k] = v;
  }
  const maxAge = searchParams.get("maxAgeDays");
  if (maxAge) filters.maxAgeDays = Number(maxAge);
  // Tabs (§11): new = first seen since previous run; changed = meaningful
  // diff recorded; strong = high-confidence match (≥75).
  const tab = searchParams.get("tab");
  if (tab === "new") filters.isNew = true;
  else if (tab === "changed") filters.changed = true;
  else if (tab === "strong") filters.highConfidence = true;
  const res = await getOpportunities({ profileIds: parseIds(searchParams), minScore: minScore ? Number(minScore) : 0, filters });
  if (!res.ok) return NextResponse.json({ error: res.error, empty: true }, { status: 200 });
  return NextResponse.json(res);
}

export async function POST(req: Request) {
  let body: { jobId?: string; profileId?: string; action?: "view" | "save" | "reject"; discoveryRunId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.jobId || !body.profileId || !["view", "save", "reject"].includes(body.action || "")) {
    return NextResponse.json({ error: "jobId, profileId, and action (view|save|reject) required" }, { status: 400 });
  }
  const res = await recordJobEvent(body.jobId, body.profileId, body.action as "view" | "save" | "reject",
    typeof body.discoveryRunId === "string" && body.discoveryRunId ? { discoveryRunId: body.discoveryRunId } : undefined);
  return NextResponse.json(res);
}
