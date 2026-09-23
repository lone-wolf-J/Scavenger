import { NextResponse } from "next/server";
import { listProfiles, createManualProfile } from "@/lib/scavenger/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ profiles: await listProfiles() });
  } catch (e) {
    return NextResponse.json({ error: `profiles unavailable: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  try {
    const record = await createManualProfile({
      name: typeof body.name === "string" ? body.name : undefined,
      targetRoles: Array.isArray(body.targetRoles) ? body.targetRoles.filter((x): x is string => typeof x === "string") : [],
      seniority: typeof body.seniority === "string" ? body.seniority : "",
      skills: Array.isArray(body.skills) ? body.skills.filter((x): x is string => typeof x === "string") : [],
      technologies: Array.isArray(body.technologies) ? body.technologies.filter((x): x is string => typeof x === "string") : [],
      industries: Array.isArray(body.industries) ? body.industries.filter((x): x is string => typeof x === "string") : [],
      domains: Array.isArray(body.domains) ? body.domains.filter((x): x is string => typeof x === "string") : [],
      functionalAreas: Array.isArray(body.functionalAreas) ? body.functionalAreas.filter((x): x is string => typeof x === "string") : [],
      yearsExperience: typeof body.yearsExperience === "number" ? body.yearsExperience : null,
      location: typeof body.location === "string" ? body.location : "",
      workplace: typeof body.workplace === "string" ? body.workplace : "",
      employment: typeof body.employment === "string" ? body.employment : "",
      compMin: typeof body.compMin === "number" ? body.compMin : null,
      exclusions: Array.isArray(body.exclusions) ? body.exclusions.filter((x): x is string => typeof x === "string") : [],
    });
    return NextResponse.json({ profile: record });
  } catch (e) {
    return NextResponse.json({ error: `create failed: ${(e as Error).message}` }, { status: 500 });
  }
}
