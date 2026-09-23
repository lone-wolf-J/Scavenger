"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Upload, Copy, Archive, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";

type Profile = {
  id: string;
  name: string;
  profile: Record<string, unknown>;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  confirmedAt?: string;
};

const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function ProfileCard({ p, onChange }: { p: Profile; onChange: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const prof = (p.profile || {}) as Record<string, unknown>;
  const conf = typeof prof.profileConfidence === "number" ? prof.profileConfidence : null;
  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    await fetch(`/api/sc/profiles/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    setBusy(false);
    onChange();
  }
  async function remove() {
    if (!confirm(`Delete profile "${p.name}"? Saved history keeps its records; the profile itself is gone.`)) return;
    setBusy(true);
    await fetch(`/api/sc/profiles/${p.id}`, { method: "DELETE" });
    setBusy(false);
    onChange();
  }
  return (
    <div className="rounded-2xl border border-border bg-surface/30 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium text-foreground">{p.name}</div>
          <div className="mt-0.5 text-xs text-muted">
            {(strList(prof.targetRoles).slice(0, 3).join(" · ") || "no target roles")}
            {typeof prof.seniority === "string" && prof.seniority ? ` — ${prof.seniority}` : ""}
            {conf != null ? ` — confidence ${conf}` : ""}
            {p.state === "archived" ? " — archived" : ""}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {strList(prof.skills).slice(0, 5).join(", ")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button title="Open" onClick={() => router.push(`/profiles/${p.id}`)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground">
            <Pencil className="size-3.5" />
          </button>
          <button title="Duplicate" disabled={busy} onClick={() => act("duplicate")} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground">
            <Copy className="size-3.5" />
          </button>
          {p.state === "active" ? (
            <button title="Archive" disabled={busy} onClick={() => act("", { state: "archived" })} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground">
              <Archive className="size-3.5" />
            </button>
          ) : (
            <button title="Unarchive" disabled={busy} onClick={() => act("", { state: "active" })} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground">
              <Plus className="size-3.5" />
            </button>
          )}
          <button title="Delete" disabled={busy} onClick={remove} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProfilesManager({ initial }: { initial: Profile[] }) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<Profile[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [manual, setManual] = useState({ name: "", targetRoles: "", seniority: "", skills: "" });
  const [creating, setCreating] = useState(false);

  async function refresh() {
    const res = await fetch("/api/sc/profiles");
    const data = await res.json();
    setProfiles(data.profiles || []);
    router.refresh();
  }

  async function upload(file: File) {
    setUploading(true);
    setUploadError("");
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/sc/documents", { method: "POST", body: form });
    const data = await res.json();
    setUploading(false);
    if (!res.ok || !data.draftId) {
      // Honest failure (§21): the server explains; we display it verbatim.
      setUploadError(data.error || "upload failed");
      return;
    }
    router.push(`/profiles/review?draft=${data.draftId}`);
  }

  async function createManual() {
    setCreating(true);
    const res = await fetch("/api/sc/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: manual.name || undefined,
        targetRoles: manual.targetRoles.split(",").map((s) => s.trim()).filter(Boolean),
        seniority: manual.seniority,
        skills: manual.skills.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    });
    setCreating(false);
    if (res.ok) {
      setShowManual(false);
      setManual({ name: "", targetRoles: "", seniority: "", skills: "" });
      refresh();
    }
  }

  const active = profiles.filter((p) => p.state !== "archived");
  const archived = profiles.filter((p) => p.state === "archived");

  return (
    <div className="mt-6 space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="cursor-pointer rounded-2xl border border-dashed border-border bg-surface/30 px-5 py-5 text-sm hover:bg-surface-hover">
          <div className="flex items-center gap-2 font-medium text-foreground">
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Create from resume
          </div>
          <div className="mt-1 text-xs text-muted">Upload .txt, .md, .pdf or .docx — Scavenger extracts career signals for your review.</div>
          <input
            type="file"
            className="hidden"
            accept=".txt,.md,.pdf,.docx"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
        </label>
        <button onClick={() => setShowManual((v) => !v)} className="rounded-2xl border border-dashed border-border bg-surface/30 px-5 py-5 text-left text-sm hover:bg-surface-hover">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Plus className="size-4" /> Create manually
          </div>
          <div className="mt-1 text-xs text-muted">No resume needed — enter target roles, seniority and skills directly.</div>
        </button>
      </div>
      {uploadError && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">{uploadError}</div>}

      {showManual && (
        <div className="space-y-3 rounded-2xl border border-border bg-surface/30 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} placeholder="Profile name (e.g. HR Leadership)" className="rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            <input value={manual.seniority} onChange={(e) => setManual({ ...manual, seniority: e.target.value })} placeholder="Seniority (e.g. senior)" className="rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            <input value={manual.targetRoles} onChange={(e) => setManual({ ...manual, targetRoles: e.target.value })} placeholder="Target roles, comma-separated" className="rounded-md border border-border bg-surface px-3 py-2 text-sm sm:col-span-2" />
            <input value={manual.skills} onChange={(e) => setManual({ ...manual, skills: e.target.value })} placeholder="Key skills, comma-separated" className="rounded-md border border-border bg-surface px-3 py-2 text-sm sm:col-span-2" />
          </div>
          <Button disabled={creating} onClick={createManual}>
            {creating && <Loader2 className="size-3.5 animate-spin" />} Save profile
          </Button>
        </div>
      )}

      {active.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center text-sm text-muted">
          No profiles yet. Upload a resume or create one manually to start matching.
        </div>
      )}
      <div className="space-y-3">
        {active.map((p) => <ProfileCard key={p.id} p={p} onChange={refresh} />)}
      </div>
      {archived.length > 0 && (
        <>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Archived</h2>
          <div className="space-y-3 opacity-75">
            {archived.map((p) => <ProfileCard key={p.id} p={p} onChange={refresh} />)}
          </div>
        </>
      )}
    </div>
  );
}
