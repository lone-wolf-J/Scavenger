import { NextResponse } from "next/server";
import { getSaved } from "@/lib/scavenger/opportunities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ saved: await getSaved() });
  } catch (e) {
    return NextResponse.json({ error: `saved unavailable: ${(e as Error).message}` }, { status: 500 });
  }
}
