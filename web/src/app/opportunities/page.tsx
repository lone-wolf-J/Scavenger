import { listProfiles } from "@/lib/scavenger/workspace";
import { OpportunitiesBoard } from "@/components/scavenger/opportunities-board";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage() {
  const profiles = await listProfiles();
  const active = profiles.filter((p: { state?: string }) => p.state === "active");
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Opportunities</h1>
      <p className="mt-1 text-sm text-muted">
        Select one or several profiles. Jobs are retrieved once from shared intelligence, then matched against each profile — each opportunity appears a single time.
      </p>
      <OpportunitiesBoard profiles={active.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))} />
    </div>
  );
}
