"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const LIST_FIELDS = [
  "targetRoles", "currentRoles", "skills", "technologies", "domains",
  "industries", "functionalAreas", "leadershipSignals", "exclusions",
] as const;

function toCsv(v: unknown): string {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "";
}

export function ProfileEditor({ initial }: { initial: { id: string; name: string; profile: Record<string, unknown> } }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [seniority, setSeniority] = useState(String(initial.profile.seniority || ""));
  const [years, setYears] = useState(
    initial.profile.yearsExperience != null ? String(initial.profile.yearsExperience) : "",
  );
  const [lists, setLists] = useState<Record<string, string>>(() =>
    Object.fromEntries(LIST_FIELDS.map((f) => [f, toCsv(initial.profile[f])])),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    const profile = {
      ...initial.profile,
      seniority,
      yearsExperience: years.trim() === "" ? null : Number(years),
      ...Object.fromEntries(
        LIST_FIELDS.map((f) => [f, lists[f].split(",").map((s) => s.trim()).filter(Boolean)]),
      ),
    };
    const res = await fetch(`/api/sc/profiles/${initial.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, profile }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-muted">
          Profile name
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-muted">
            Seniority
            <input value={seniority} onChange={(e) => setSeniority(e.target.value)} placeholder="senior" className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground" />
          </label>
          <label className="text-xs text-muted">
            Years experience
            <input value={years} onChange={(e) => setYears(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground" />
          </label>
        </div>
      </div>
      {LIST_FIELDS.map((f) => (
        <label key={f} className="block text-xs text-muted">
          {f}
          <textarea
            value={lists[f]}
            onChange={(e) => setLists({ ...lists, [f]: e.target.value })}
            rows={f === "skills" || f === "targetRoles" ? 2 : 1}
            placeholder="comma-separated"
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
          />
        </label>
      ))}
      <div className="flex items-center gap-3">
        <Button disabled={saving} onClick={save}>
          {saving && <Loader2 className="size-3.5 animate-spin" />} Save changes
        </Button>
        {saved && <span className="text-xs text-muted">Saved.</span>}
      </div>
    </div>
  );
}
