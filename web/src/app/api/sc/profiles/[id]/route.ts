import { NextResponse } from "next/server";
import { getWorkspace, patchProfile, deleteProfileById } from "@/lib/scavenger/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const state = await getWorkspace();
  const record = (state.profiles || []).find((p: { id: string }) => p.id === id);
  if (!record) return NextResponse.json({ error: "profile not found" }, { status: 404 });
  return NextResponse.json({ profile: record });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { name?: string; state?: string; action?: string; profile?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const res = await patchProfile(id, { name: body.name, state: body.state, action: body.action, profile: body.profile });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
  return NextResponse.json({ profile: res.profile });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await deleteProfileById(id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
  return NextResponse.json({ ok: true });
}
