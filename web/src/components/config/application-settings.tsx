"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";

type Profile = { id: string; name: string };

type Rules = {
  mode: string;
  matchThreshold: number;
  requireUSTrue: boolean;
  workplacePrefs: string[];
  employmentPrefs: string[];
  seniorityPrefs: string[];
  salaryMin: number;
  targetRoles: string[];
  excludedCompanies: string[];
  dailyLimit: number;
  requireApprovalIf: Record<string, boolean>;
};

const DEFAULT_RULES: Rules = {
  mode: "MANUAL",
  matchThreshold: 75,
  requireUSTrue: true,
  workplacePrefs: [],
  employmentPrefs: [],
  seniorityPrefs: [],
  salaryMin: 0,
  targetRoles: [],
  excludedCompanies: [],
  dailyLimit: 5,
  requireApprovalIf: {
    salaryUnavailable: true,
    locationAmbiguous: true,
    roleDiffersFromTarget: true,
    screeningQuestionsRequireUnknown: true,
    requiresCAPTCHA: true,
    requiresInfoNotInProfile: true,
  },
};

export function ApplicationSettings({ profiles: initialProfiles }: { profiles: Profile[] }) {
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
  const [selectedProfile, setSelectedProfile] = useState(initialProfiles[0]?.id || "");
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [excludedInput, setExcludedInput] = useState("");

  const loadSettings = useCallback(async () => {
    if (!selectedProfile) return;
    setLoading(true);
    const res = await fetch(`/api/sc/applications/settings?profileId=${selectedProfile}`);
    const data = await res.json();
    if (data.rules) setRules({ ...DEFAULT_RULES, ...data.rules });
    setLoading(false);
  }, [selectedProfile]);

  useEffect(() => {
    if (profiles.length === 0) {
      fetch("/api/sc/profiles").then((r) => r.json()).then((d) => {
        const active = (d.profiles || []).filter((p: Profile & { state?: string }) => p.state !== "archived");
        setProfiles(active);
        if (active.length > 0 && !selectedProfile) setSelectedProfile(active[0].id);
      }).catch(() => {});
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  async function saveSettings() {
    setSaving(true); setSaved(false);
    await fetch("/api/sc/applications/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: selectedProfile, rules }),
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function addExcluded() {
    const c = excludedInput.trim();
    if (c && !rules.excludedCompanies.includes(c)) {
      setRules({ ...rules, excludedCompanies: [...rules.excludedCompanies, c] });
      setExcludedInput("");
    }
  }

  if (profiles.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Application Automation</h3>
          <p className="mt-1 text-xs text-muted">Create a profile first to configure application settings.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Application Automation</h3>
        <p className="mt-1 text-xs text-muted">Configure how Scavenger handles applications for each profile.</p>
      </div>

      <div>
        <label className="text-xs text-muted">Profile</label>
        <select value={selectedProfile} onChange={(e) => setSelectedProfile(e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm">
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Loading...</div>
      ) : (
        <>
          <div>
            <label className="text-xs font-medium text-muted">Application Mode</label>
            <div className="mt-1.5 space-y-2">
              {(["MANUAL", "ASSISTED", "AUTOMATIC"] as const).map((m) => (
                <label key={m} className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="appMode" checked={rules.mode === m}
                    onChange={() => setRules({ ...rules, mode: m })} className="mt-0.5" />
                  <div>
                    <div className="text-sm text-foreground">{m === "MANUAL" ? "Ask me before every application" : m === "ASSISTED" ? "Prepare applications automatically, but ask before submitting" : "Automatically submit applications that meet my rules"}</div>
                    {m === "AUTOMATIC" && rules.mode === "AUTOMATIC" && (
                      <div className="mt-1 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="inline size-3 mr-1" />
                        Automatic application can submit applications on your behalf. Scavenger will only apply when all configured rules are satisfied.
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs text-muted">Minimum match score</label>
              <input type="number" value={rules.matchThreshold} min={0} max={100}
                onChange={(e) => setRules({ ...rules, matchThreshold: Number(e.target.value) || 0 })}
                className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted">Daily application limit</label>
              <input type="number" value={rules.dailyLimit} min={1} max={50}
                onChange={(e) => setRules({ ...rules, dailyLimit: Number(e.target.value) || 5 })}
                className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted">Minimum salary</label>
              <input type="number" value={rules.salaryMin} min={0} step={10000}
                onChange={(e) => setRules({ ...rules, salaryMin: Number(e.target.value) || 0 })}
                className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" placeholder="0 = no minimum" />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={rules.requireUSTrue}
                  onChange={(e) => setRules({ ...rules, requireUSTrue: e.target.checked })} />
                US only
              </label>
            </div>
          </div>

          <div>
            <label className="text-xs text-muted">Excluded companies</label>
            <div className="mt-1 flex gap-2">
              <input value={excludedInput} onChange={(e) => setExcludedInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addExcluded())}
                placeholder="Add company name"
                className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm" />
              <button onClick={addExcluded} className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:bg-surface-hover">Add</button>
            </div>
            {rules.excludedCompanies.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {rules.excludedCompanies.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
                    {c}
                    <button onClick={() => setRules({ ...rules, excludedCompanies: rules.excludedCompanies.filter((x) => x !== c) })}
                      className="text-muted hover:text-foreground">&times;</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-muted">Require approval if</label>
            <div className="mt-1.5 grid gap-1 sm:grid-cols-2">
              {Object.entries(rules.requireApprovalIf).map(([key, val]) => (
                <label key={key} className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
                  <input type="checkbox" checked={val}
                    onChange={(e) => setRules({ ...rules, requireApprovalIf: { ...rules.requireApprovalIf, [key]: e.target.checked } })} />
                  {key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
                </label>
              ))}
            </div>
          </div>

          <button onClick={saveSettings} disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand-200 disabled:opacity-50">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : null}
            {saved ? "Saved" : "Save Rules"}
          </button>
        </>
      )}
    </div>
  );
}
