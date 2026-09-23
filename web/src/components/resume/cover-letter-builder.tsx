"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail, Loader2, Eye, Download } from "lucide-react";
import { cn } from "@/lib/cn";

type Profile = { id: string; name: string };

export function CoverLetterBuilder() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [position, setPosition] = useState("");
  const [hiringManager, setHiringManager] = useState("");
  const [body, setBody] = useState("");
  const [closing, setClosing] = useState("Sincerely,");
  const [previewHtml, setPreviewHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  useEffect(() => {
    fetch("/api/sc/profiles")
      .then((r) => r.json())
      .then((d) => {
        const active = (d.profiles || []).filter((p: Profile & { state?: string }) => p.state !== "archived");
        setProfiles(active);
        if (active.length > 0) setSelectedProfile(active[0].id);
      })
      .catch(() => {});
  }, []);

  const loadProfileName = useCallback(async () => {
    if (!selectedProfile) return "";
    const res = await fetch(`/api/sc/profiles/${selectedProfile}`);
    const d = await res.json();
    return (d.profile?.name as string) || d.name || "";
  }, [selectedProfile]);

  async function generatePreview() {
    setLoading(true);
    const name = await loadProfileName();
    const params = new URLSearchParams({
      name, company: companyName, position,
      hiringManager, body, closing,
    });
    try {
      const res = await fetch(`/api/sc/cover-letter?${params.toString()}`);
      const html = await res.text();
      setPreviewHtml(html);
      setTab("preview");
    } catch {}
    setLoading(false);
  }

  function downloadHtml() {
    if (!previewHtml) return;
    const blob = new Blob([previewHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cover-letter-${companyName.replace(/\s+/g, "-").toLowerCase() || "draft"}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function input(label: string, value: string, onChange: (v: string) => void, opts?: { multiline?: boolean; placeholder?: string }) {
    return (
      <div>
        <label className="text-xs text-muted">{label}</label>
        {opts?.multiline ? (
          <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={opts.placeholder}
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm min-h-[160px] leading-relaxed" />
        ) : (
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={opts?.placeholder}
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2"><Mail className="size-5" /> Cover Letter Builder</h2>
        <p className="text-xs text-muted mt-0.5">Generate a tailored cover letter for a specific role</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs text-muted">Your profile</label>
          <select value={selectedProfile} onChange={(e) => setSelectedProfile(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm">
            <option value="">Select profile...</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {input("Company", companyName, setCompanyName, { placeholder: "Acme Corp" })}
        {input("Position", position, setPosition, { placeholder: "Senior Engineer" })}
        {input("Hiring Manager (optional)", hiringManager, setHiringManager, { placeholder: "Jane Smith" })}
      </div>

      {input("Cover Letter Body", body, setBody, {
        multiline: true,
        placeholder: "I am excited to apply for the Senior Engineer position at Acme Corp. With 5 years of experience in full-stack development, I have led teams that shipped products serving millions of users.\n\nAt my previous role at TechCorp, I spearheaded the migration to a microservices architecture, reducing deployment time by 60%. I am passionate about building scalable systems and mentoring junior developers.\n\nI would love to bring my expertise in system design and team leadership to Acme Corp's engineering team.",
      })}

      {input("Closing", closing, setClosing, { placeholder: "Sincerely," })}

      <div className="flex gap-2">
        <button onClick={generatePreview} disabled={loading || !companyName || !position || !body}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand-200 disabled:opacity-50">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
          Generate Preview
        </button>
      </div>

      {tab === "preview" && previewHtml && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-white">
            <iframe srcDoc={previewHtml} className="w-full min-h-[500px] rounded-lg" title="Cover Letter Preview" />
          </div>
          <div className="flex gap-2">
            <button onClick={downloadHtml}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm text-muted hover:bg-surface-hover">
              <Download className="size-4" /> Download HTML
            </button>
            <button onClick={() => { const w = window.open("", "_blank"); w?.document.write(previewHtml); w?.document.close(); }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm text-muted hover:bg-surface-hover">
              Open in new tab (print to PDF)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
