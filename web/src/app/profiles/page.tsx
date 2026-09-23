import { listProfiles } from "@/lib/scavenger/workspace";
import { ProfilesManager } from "@/components/scavenger/profiles-manager";

export const dynamic = "force-dynamic";

export default async function ProfilesPage() {
  const profiles = await listProfiles();
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">My Profiles</h1>
          <p className="mt-1 text-sm text-muted">
            One user, many professional identities. Each profile matches independently — editing one never alters another.
          </p>
        </div>
      </div>
      <ProfilesManager initial={profiles} />
    </div>
  );
}
