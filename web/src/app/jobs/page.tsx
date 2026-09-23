import { listProfiles } from "@/lib/scavenger/workspace";
import { JobsView } from "@/components/jobs/jobs-view";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const profiles = await listProfiles();
  const active = profiles.filter((p: { state?: string }) => p.state !== "archived");
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <JobsView profiles={active.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))} />
    </div>
  );
}
