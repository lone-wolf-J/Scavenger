import { NextResponse } from "next/server";
import {
  listApplications,
  createApplicationFromJob,
  transitionApplicationStatus,
  getApplicationMetrics,
} from "@/lib/scavenger/applications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sc/applications — list applications
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const profileId = url.searchParams.get("profileId") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const applications = await listApplications({ profileId, status });
    const metrics = await getApplicationMetrics();
    return NextResponse.json({ applications, metrics });
  } catch (e) {
    return NextResponse.json({ error: `applications unavailable: ${(e as Error).message}` }, { status: 500 });
  }
}

// POST /api/sc/applications — create application from job
export async function POST(req: Request) {
  let body: { jobId?: string; profileId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.jobId || !body.profileId) {
    return NextResponse.json({ error: "jobId and profileId required" }, { status: 400 });
  }
  try {
    const result = await createApplicationFromJob({ jobId: body.jobId, profileId: body.profileId });
    if (!result.ok) {
      return NextResponse.json({ error: result.message || result.reason }, { status: result.reason === "duplicate" ? 409 : 422 });
    }
    return NextResponse.json({ application: result.application });
  } catch (e) {
    return NextResponse.json({ error: `create failed: ${(e as Error).message}` }, { status: 500 });
  }
}

// PATCH /api/sc/applications — transition status
export async function PATCH(req: Request) {
  let body: { applicationId?: string; status?: string; detail?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.applicationId || !body.status) {
    return NextResponse.json({ error: "applicationId and status required" }, { status: 400 });
  }
  try {
    const result = await transitionApplicationStatus(body.applicationId, body.status, { detail: body.detail || "" });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }
    return NextResponse.json({ application: result.application });
  } catch (e) {
    return NextResponse.json({ error: `transition failed: ${(e as Error).message}` }, { status: 500 });
  }
}
