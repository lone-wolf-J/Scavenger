import { NextResponse } from "next/server";
import {
  getApplicationRules,
  setApplicationRules,
  getApplicationAnswers,
  setApplicationAnswers,
} from "@/lib/scavenger/applications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sc/applications/settings — get rules + answers for a profile
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const profileId = url.searchParams.get("profileId");
    if (!profileId) return NextResponse.json({ error: "profileId required" }, { status: 400 });
    const rules = await getApplicationRules(profileId);
    const answers = await getApplicationAnswers(profileId);
    return NextResponse.json({ rules, answers });
  } catch (e) {
    return NextResponse.json({ error: `settings unavailable: ${(e as Error).message}` }, { status: 500 });
  }
}

// POST /api/sc/applications/settings — save rules or answers
export async function POST(req: Request) {
  let body: { profileId?: string; rules?: Record<string, unknown>; answers?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.profileId) {
    return NextResponse.json({ error: "profileId required" }, { status: 400 });
  }
  try {
    if (body.rules) await setApplicationRules(body.profileId, body.rules);
    if (body.answers) await setApplicationAnswers(body.profileId, body.answers);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: `save failed: ${(e as Error).message}` }, { status: 500 });
  }
}
