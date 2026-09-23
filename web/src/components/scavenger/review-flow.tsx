"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type Correction = { op: string; field: string; value?: string };

const EDITABLE_LISTS = [
  "targetRoles", "currentRoles", "skills", "technologies", "domains",
  "industries", "functionalAreas", "leadershipSignals", "exclusions",
];

export function ReviewFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const draftId = params.get("draft") || "";
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [removals, setRemovals] = useState<Correction[]>([]);
  const [adopt, setAdopt] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!draftId) {
      setError("No draft selected — upload a resume from Profiles first.");
      return;
    }
    fetch(`/api/sc/review?draft=${encodeURIComponent(draftId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setDraft(d.draft);
      })
      .catch(() => setError("Could not load the draft."));
  }, [draftId]);

  if (error) return <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</div>;
  if (!draft) return <p className="mt-6 text-sm text-muted">Loading draft…</p>;

  const profile = (draft.profile || {}) as Record<string, unknown>;
  const signals = (draft.signals || {}) as Record<string, unknown>;

  function listOf(field: string): string[] {
    if (edits[field] !== undefined) return edits[field].split(",").map((s) => s.trim()).filter(Boolean);
    const v = profile[field];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }

  function buildCorrections(): Correction[] {
    const ops: Correction[] = [...removals];
    for (const f of EDITABLE_LISTS) {
      if (edits[f] === undefined) continue;
      const before = new Set(
        (Array.isArray(profile[f]) ? (profile[f] as string[]) : []).map((s) => s.toLowerCase()),
      );
      for (const item of listOf(f)) {
        if (!before.has(item.toLowerCase())) ops.push({ op: "add", field: f, value: item });
      }
      for (const item of before) {
        if (!listOf(f).some((x) => x.toLowerCase() === item)) ops.push({ op: "remove", field: f, value: item });
      }
    }
    if (edits.seniority !== undefined && edits.seniority !== String(profile.seniority || "")) {
      ops.push({ op: "set", field: "seniority", value: edits.seniority });
    }
    return ops;
  }

  async function confirm() {
    setConfirming(true);
    const res = await fetch("/api/sc/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftId, corrections: buildCorrections(), adopt, name: name || undefined }),
    });
    const data = await res.json();
    setConfirming(false);
    if (res.ok) router.push(`/profiles/${data.profile.id}`);
    else setError(data.error || "Confirm failed.");
  }

  const inferred = (profile.inferredTargets || draft.inferred || []) as Array<{ role: string; confidence: number; evidence?: string[] }>;
  // renderReview-equivalent provenance: skills/currentRoles carry explicit evidence.
  const evidenceFor = (field: string): string[] => {
    if (field === "skills") return (((signals.skills || []) as Array<{ evidence?: string[] }>).slice(0, 2).flatMap((s) => s.evidence || []));
    if (field === "currentRoles" || field === "targetRoles") {
      return ([...(((signals.currentRoles || []) as Array<{ evidence?: string[] }>)), ...(((signals.previousRoles || []) as Array<{ evidence?: string[] }>))].slice(0, 2).flatMap((r) => r.evidence || []));
    }
    return [];
  };

  return (
    <div className="mt-6 space-y-4">
      <label className="block text-xs text-muted">
        Profile name (rename freely — Scavenger never forces a profession into it)
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HR Leadership" className="mt-1 w-full max-w-md rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground" />
      </label>

      {EDITABLE_LISTS.map((f) => (
        <div key={f} className="rounded-2xl border border-border bg-surface/30 px-5 py-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">{f}</div>
          <textarea
            value={edits[f] ?? listOf(f).join(", ")}
            onChange={(e) => setEdits({ ...edits, [f]: e.target.value })}
            rows={2}
            className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
          />
          {evidenceFor(f).map((e, i) => (
            <div key={i} className="mt-1 text-xs text-muted">explicit: {e}</div>
          ))}
        </div>
      ))}

      <div className="rounded-2xl border border-border bg-surface/30 px-5 py-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">seniority</div>
        <input
          value={edits.seniority ?? String(profile.seniority || "")}
          onChange={(e) => setEdits({ ...edits, seniority: e.target.value })}
          className="mt-2 w-full max-w-xs rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
        />
      </div>

      {inferred.length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-5 py-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Inferred from your experience — adopt only what you want</div>
          {inferred.map((t) => (
            <label key={t.role} className="mt-2 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={adopt.includes(t.role)}
                onChange={(e) => setAdopt(e.target.checked ? [...adopt, t.role] : adopt.filter((r) => r !== t.role))}
              />
              <span>
                <span className="text-foreground">{t.role}</span>{" "}
                <span className="text-xs text-muted">(confidence {t.confidence}{(t.evidence || []).length ? `: ${(t.evidence || []).join("; ")}` : ""})</span>
              </span>
            </label>
          ))}
        </div>
      )}

      <Button disabled={confirming} onClick={confirm}>
        {confirming && <Loader2 className="size-3.5 animate-spin" />} Confirm profile
      </Button>
    </div>
  );
}
