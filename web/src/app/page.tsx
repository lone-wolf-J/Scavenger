import { listProfiles } from "@/lib/scavenger/workspace";
import { HomeClient } from "@/components/home/home-client";

export const dynamic = "force-dynamic";

export default async function Home() {
  const profiles = await listProfiles();
  const active = profiles.filter((p: { state?: string }) => p.state !== "archived");
  return <HomeClient profiles={active.map((p: { id: string; name: string; profile: Record<string, unknown> }) => ({ id: p.id, name: p.name, profile: p.profile }))} />;
}
