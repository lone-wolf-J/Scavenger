"use client";

import { useEffect, useRef, useState } from "react";
import {
  Building2, Send, Loader2, Search, ExternalLink, Bookmark, BookmarkCheck,
  X, ChevronDown, ChevronUp, Sparkles, Upload, Download,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { ApplyPanel, type Agg } from "@/components/jobs/jobs-view";

type ProfileRef = { id: string; name: string };

type Match = Agg["matches"][number];

type CompanyState = {
  name: string;
  phase: "queued" | "crawling" | "done" | "error";
  detail: string;
  provider?: string;
  resolvedUrl?: string;
  fetched?: number;
  accepted?: number;
  results: Agg[];
  totalMatched: number;
};

function bandLabel(band: Match["band"]): string {
  if (!band) return "";
  return typeof band === "string" ? band : band.label || "";
}

function bandColor(band: Match["band"]): string {
  const l = bandLabel(band);
  if (l === "strong") return "text-emerald-600 dark:text-emerald-400";
  if (l === "good") return "text-blue-600 dark:text-blue-400";
  if (l === "weak") return "text-amber-600 dark:text-amber-400";
  return "text-muted";
}

function JobCard({ agg, names, defaultProfileId, onChanged }: {
  agg: Agg;
  names: Record<string, string>;
  defaultProfileId: string;
  onChanged: (jobId: string, outcome: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [applying, setApplying] = useState(false);
  const job = agg.job || { title: agg.jobId, company: "", location: "", url: "" };
  const saved = Object.values(agg.history || {}).some((h) =>
    ["saved", "applied", "interview", "offer", "hired"].includes(h.outcome || ""));
  const rejected = Object.keys(agg.history || {}).length > 0 &&
    Object.values(agg.history || {}).every((h) => h.outcome === "rejected");
  if (rejected) return null;

  async function act(profileId: string, action: "save" | "reject") {
    await fetch("/api/sc/opportunities", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: agg.jobId, profileId, action }),
    });
    onChanged(agg.jobId, action === "save" ? "saved" : null);
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/30 px-5 py-4 transition-colors hover:bg-surface/50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">{job.title}</div>
          <div className="mt-0.5 text-xs text-muted">
            {job.company}{job.location ? ` · ${job.location}` : ""}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {agg.matches.map((m) => (
              <span key={m.profileId} className={cn("rounded-full border border-border px-2 py-0.5 text-xs tabular-nums", bandColor(m.band))}>
                {names[m.profileId] || m.profileId}: {m.score}%
              </span>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn("font-display text-2xl tabular-nums", bandColor(agg.best.band))}>{agg.best.score}<span className="text-sm text-muted">%</span></div>
          <div className="text-xs text-muted">{bandLabel(agg.best.band)}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button onClick={() => setApplying(!applying)}
          className="inline-flex items-center gap-1 rounded-md border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-brand hover:bg-brand/20">
          <Send className="size-3" /> Apply
        </button>
        <button onClick={() => act(agg.best.profileId, saved ? "reject" : "save")}
          className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 hover:bg-surface-hover",
            saved ? "border-brand/30 text-brand" : "text-muted hover:text-foreground")}>
          {saved ? <BookmarkCheck className="size-3" /> : <Bookmark className="size-3" />} {saved ? "Saved" : "Save"}
        </button>
        <button onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />} Why matched
        </button>
        {job.url && (
          <a href={job.url} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
            <ExternalLink className="size-3" /> View Job
          </a>
        )}
        {saved && (
          <button onClick={() => act(agg.best.profileId, "reject")}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
            <X className="size-3" /> Remove
          </button>
        )}
      </div>

      {applying && (
        <ApplyPanel
          agg={agg}
          profileId={agg.best.profileId || defaultProfileId}
          profileName={names[agg.best.profileId || defaultProfileId] || "Selected profile"}
          onApplied={() => { setApplying(false); onChanged(agg.jobId, "applied"); }}
          onClose={() => setApplying(false)}
        />
      )}

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {agg.matches.map((m) => (
            <div key={m.profileId}>
              <div className="text-xs font-medium text-foreground">
                {names[m.profileId] || m.profileId} — {m.score}% match
              </div>
              {m.reasons.length > 0 && (
                <div className="mt-1">
                  <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted">Why this matches</div>
                  {m.reasons.slice(0, 5).map((r, i) => (
                    <div key={i} className="flex items-start gap-1 text-xs text-muted">
                      <span className="mt-0.5 text-emerald-500">✓</span> {r}
                    </div>
                  ))}
                </div>
              )}
              {(m.penalties.length > 0 || (m.missingSignals || []).length > 0) && (
                <div className="mt-1">
                  <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted">Potential gaps</div>
                  {m.penalties.slice(0, 3).map((r, i) => (
                    <div key={i} className="flex items-start gap-1 text-xs text-muted">
                      <span className="mt-0.5 text-amber-500">•</span> {r}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CompaniesView({ profiles }: { profiles: ProfileRef[] }) {
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<string[]>(profiles.map((p) => p.id));
  const [companies, setCompanies] = useState<CompanyState[]>([]);
  const [crawling, setCrawling] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState("");
  const aliveRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const names = Object.fromEntries(profiles.map((p) => [p.id, p.name]));

  function patchCompany(name: string, patch: Partial<CompanyState>) {
    setCompanies((prev) => prev.map((c) => (c.name === name ? { ...c, ...patch } : c)));
  }

  function handleChanged(jobId: string, outcome: string | null) {
    setCompanies((prev) => prev.map((c) => ({
      ...c,
      results: c.results.map((a) => {
        if (a.jobId !== jobId) return a;
        const history = { ...(a.history || {}) };
        const pid = a.best.profileId;
        if (outcome) history[pid] = { ...(history[pid] || {}), outcome };
        else delete history[pid];
        return { ...a, history };
      }),
    })));
  }

  async function crawlList(names: string[]) {
    const fresh: CompanyState[] = names.map((name: string) => ({
      name, phase: "queued" as const, detail: "Queued", results: [], totalMatched: 0,
    }));
    setCompanies((prev) => {
      const known = new Set(prev.map((c) => c.name.toLowerCase()));
      return [...prev, ...fresh.filter((c) => !known.has(c.name.toLowerCase()))];
    });
    setCrawling(true);
    setElapsed(0);
    const t0 = Date.now();
    const timer = setInterval(() => { if (aliveRef.current) setElapsed(Math.round((Date.now() - t0) / 1000)); }, 500);
    try {
      for (const name of names as string[]) {
        if (!aliveRef.current) break;
        patchCompany(name, { phase: "crawling", detail: "Resolving career site…" });
        try {
          const res = await fetch("/api/sc/companies/crawl", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ company: name, profileIds: selected }),
          });
          const data = await res.json();
          if (!aliveRef.current) break;
          if (!res.ok || data.error) {
            patchCompany(name, { phase: "error", detail: data.error || "Crawl failed" });
            continue;
          }
          const crawl = data.crawl || {};
          const src = crawl.resolvedUrl
            ? `via ${crawl.providerId} · ${crawl.fetched} fetched → ${crawl.accepted} kept`
            : `board unresolved — keyword search only · ${crawl.fetched} fetched → ${crawl.accepted} kept`;
          patchCompany(name, {
            phase: "done",
            detail: crawl.status === "FAILED" ? (crawl.errors?.[0]?.message || "No jobs retrieved") : src,
            provider: crawl.providerId,
            resolvedUrl: crawl.resolvedUrl,
            fetched: crawl.fetched,
            accepted: crawl.accepted,
            results: data.results || [],
            totalMatched: data.totalMatched ?? (data.results || []).length,
          });
        } catch {
          if (aliveRef.current) patchCompany(name, { phase: "error", detail: "Request failed" });
        }
      }
    } finally {
      clearInterval(timer);
      if (aliveRef.current) setCrawling(false);
    }
  }

  async function submit() {
    if (crawling || !input.trim()) return;
    if (!selected.length) { setNotice("Select at least one profile first."); return; }
    setNotice("");
    const parsed = await fetch("/api/sc/companies/crawl", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input }),
    }).then((r) => r.json());
    if (!parsed.companies?.length) { setNotice("No company names found — try e.g. Acme, Globex"); return; }
    if (parsed.dropped?.length) setNotice(`Skipped: ${parsed.dropped.join(", ")}`);
    setInput("");
    await crawlList(parsed.companies);
  }

  async function uploadFile(file: File) {
    if (crawling) return;
    if (!selected.length) { setNotice("Select at least one profile first."); return; }
    setNotice("");
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/sc/companies/upload", { method: "POST", body: form });
      const parsed = await res.json();
      if (!res.ok || !parsed.companies?.length) {
        setNotice(parsed.error || "No company names found in that file.");
        return;
      }
      const extra = parsed.dropped?.length ? ` Skipped: ${parsed.dropped.slice(0, 8).join(", ")}${parsed.dropped.length > 8 ? "…" : ""}` : "";
      setNotice(`Loaded ${parsed.companies.length} companies from ${file.name} (${parsed.rowsSeen} rows).${extra}`);
      await crawlList(parsed.companies);
    } catch {
      setNotice("Upload failed — check the file and try again.");
    } finally {
      if (aliveRef.current) setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function csvCell(v: unknown): string {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function downloadReport() {
    const rows: unknown[][] = [[
      "Company", "Status", "Detail", "Provider", "Source URL",
      "Jobs Fetched", "Jobs Kept", "Matched",
      "Job Title", "Location", "Score", "Band", "Profiles", "Job URL",
    ]];
    for (const c of companies) {
      const base = [c.name, c.phase, c.detail, c.provider || "", c.resolvedUrl || "",
        c.fetched ?? "", c.accepted ?? "", c.totalMatched];
      if (!c.results.length) {
        rows.push([...base, "", "", "", "", "", ""]);
      }
      for (const a of c.results) {
        const job = a.job || { title: a.jobId, company: "", location: "", url: "" };
        const band = typeof a.best.band === "string" ? a.best.band : a.best.band?.label || "";
        const profs = (a.matches || []).map((m) => `${names[m.profileId] || m.profileId}:${m.score}`).join("; ");
        rows.push([...base, job.title, job.location || "", a.best.score, band, profs, job.url || ""]);
      }
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const blob = new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `target-companies-${stamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const settled = companies.length > 0 && companies.every((c) => c.phase === "done" || c.phase === "error");

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Target Companies</h1>
          <p className="mt-1 text-sm text-muted">
            {profiles.length > 0 ? `Crawl career sites for ${profiles.length} profile${profiles.length === 1 ? "" : "s"}` : "Create a profile to start crawling"}
          </p>
        </div>
      </div>

      {profiles.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Profiles:</span>
          {profiles.map((p) => (
            <label key={p.id} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs">
              <input type="checkbox" checked={selected.includes(p.id)}
                onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
              {p.name}
            </label>
          ))}
        </div>
      )}

      <div className="mt-4 rounded-2xl border border-border bg-surface/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 shrink-0 text-brand" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder='Try "Acme, Globex" — or "find jobs at Acme and Globex"'
            className="w-full bg-transparent text-sm text-foreground placeholder:text-faint focus:outline-none"
          />
          <button onClick={submit} disabled={crawling || uploading || !input.trim()}
            className="orchid-cta inline-flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition disabled:opacity-50">
            {crawling ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            {crawling ? `Crawling… ${elapsed}s` : "Crawl"}
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={crawling || uploading}
            title="Upload an Excel file (.xlsx, .xls, .csv) — one company per row, first column, up to 100"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-muted transition hover:bg-surface-hover hover:text-foreground disabled:opacity-50">
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            {uploading ? "Reading…" : "Upload Excel"}
          </button>
          {settled && (
            <button onClick={downloadReport}
              title="Download every match as CSV"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-muted transition hover:bg-surface-hover hover:text-foreground">
              <Download className="size-3.5" /> Report
            </button>
          )}
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); }} />
        </div>
        <div className="mt-2 text-xs text-muted">
          Multiple companies at once — separate with commas, or upload an Excel file (first column = company names, up to 100).
        </div>
      </div>

      {notice && <div className="mt-4 rounded-xl border border-border bg-surface/30 px-4 py-3 text-sm text-muted">{notice}</div>}

      <div className="mt-4 space-y-6">
        {companies.map((c) => (
          <section key={c.name}>
            <div className="flex flex-wrap items-center gap-2">
              <Building2 className="size-4 text-brand" />
              <h2 className="font-medium text-foreground">{c.name}</h2>
              {c.phase === "crawling" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs text-brand-text">
                  <Loader2 className="size-3 animate-spin" /> {c.detail}
                </span>
              )}
              {c.phase === "queued" && (
                <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">Queued</span>
              )}
              {c.phase === "done" && (
                <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                  {c.totalMatched} match{c.totalMatched === 1 ? "" : "es"} · {c.detail}
                  {c.resolvedUrl && (
                    <> · <a href={c.resolvedUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">source</a></>
                  )}
                </span>
              )}
              {c.phase === "error" && (
                <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-600 dark:text-red-400">{c.detail}</span>
              )}
            </div>
            {c.phase === "done" && c.results.length === 0 && (
              <p className="mt-2 text-sm text-muted">No profile-matching jobs found at {c.name} this run.</p>
            )}
            <div className="mt-3 space-y-3">
              {c.results.map((a) => (
                <JobCard key={a.jobId} agg={a} names={names} defaultProfileId={selected[0] || ""} onChanged={handleChanged} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {companies.length === 0 && (
        <div className="mt-8 flex items-center gap-2 text-sm text-muted">
          <Search className="size-4" /> Name a company above to pull every opening from its career site, matched to your profiles.
        </div>
      )}
    </div>
  );
}
