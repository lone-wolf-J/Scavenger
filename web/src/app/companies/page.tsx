import { listProfiles } from "@/lib/scavenger/workspace";
import { CompaniesView } from "@/components/companies/companies-view";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  const profiles = await listProfiles();
  const active = profiles.filter((p: { state?: string }) => p.state !== "archived");
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <CompaniesView profiles={active.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))} />
    </div>
  );
}
