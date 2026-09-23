"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, Filter, ExternalLink, Bookmark, BookmarkCheck, X, ChevronDown, ChevronUp, Send, Play } from "lucide-react";
import { cn } from "@/lib/cn";

type ProfileRef = { id: string; name: string };
type Match = {
  profileId: string;
  score: number;
  band?: { label?: string } | string;
  reasons: string[];
  penalties: string[];
  matchedSignals?: string[];
  missingSignals?: string[];
};
type Agg = {
  jobId: string;
  best: Match;
  matches: Match[];
  history?: Record<string, { viewed?: boolean; outcome?: string }>;
  job?: { title: string; company: string; location: string; url: string; applyUrl?: string; postedAt?: number; sources?: string[]; workplaceType?: string; employmentType?: string } | null;
  intel?: { lifecycle?: string; isNew?: boolean; verificationStatus?: string | null } | null;
};

type ProviderRow = { id: string; status: string; raw: number; accepted: number; runtimeMs: number };
type DiscoveryResult = {
  status?: string; error?: string; jobsAccepted?: number;
  funnel?: { raw: number; us: number; fresh: number; unique: number };
  providers?: ProviderRow[] | Record<string, { status?: string; raw?: number; accepted?: number; runtimeMs?: number }>;
  timings?: { totalMs: number };
  errors?: Array<{ provider: string; errorType: string }>;
};

type Application = {
  applicationId: string; jobId: string; profileId: string; status: string;
  method: string; applyUrl: string; company: string; jobTitle: string;
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

function methodLabel(m: string): string {
  const map: Record<string, string> = {
    DIRECT_EMPLOYER: "Employer website", GREENHOUSE: "Greenhouse", WORKDAY: "Workday",
    LEVER: "Lever", ASHBY: "Ashby", LINKEDIN: "LinkedIn", DICE: "Dice", INDEED: "Indeed", OTHER: "Other",
  };
  return map[m] || m;
}

function DiscoveryProgress({ discovery, elapsed }: { discovery: DiscoveryResult; elapsed: number }) {
  const f = discovery.funnel;
  const inProgress = discovery.status === "QUEUED" || discovery.status === "RUNNING";
  const providers = Array.isArray(discovery.providers)
    ? discovery.providers
    : Object.entries(discovery.providers || {}).map(([id, p]) => ({ id, ...p }));
  return (
    <div className="rounded-2xl border border-border bg-surface/30 px-5 py-4 text-sm">
      {discovery.error ? (
        <div>
          <div className="font-medium text-foreground">Search failed</div>
          <div className="mt-1 text-xs text-red-600 dark:text-red-400">{discovery.error}</div>
        </div>
      ) : inProgress ? (
        <div>
          <div className="font-medium text-foreground">Searching sources ({elapsed}s)...</div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 md:grid-cols-4">
            {providers.map((p) => (
              <div key={p.id} className="flex items-center gap-1.5 text-xs">
                <span className={cn("size-1.5 rounded-full", p.status === "ACTIVE" || p.status === "COMPLETE" ? "bg-emerald-500" : p.status === "RUNNING" ? "bg-amber-500 animate-pulse" : "bg-red-400")} />
                <span className="text-foreground truncate">{p.id}</span>
                <span className="text-muted truncate">{p.status === "RUNNING" ? "..." : p.status}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <div className="font-medium text-foreground">Search complete</div>
          {f && (
            <div className="mt-1 text-xs text-muted tabular-nums">
              {f.raw} discovered &rarr; {f.us} US-eligible &rarr; {f.fresh} fresh &rarr; {f.unique} unique &rarr; {discovery.jobsAccepted || 0} matched
            </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 md:grid-cols-4">
            {providers.map((p) => (
              <div key={p.id} className="flex items-center gap-1.5 text-xs">
                <span className={cn("size-1.5 rounded-full", p.status === "ACTIVE" || p.status === "COMPLETE" ? "bg-emerald-500" : "bg-red-400")} />
                <span className="text-foreground truncate">{p.id}</span>
                <span className="text-muted">{p.accepted ?? 0} jobs</span>
              </div>
            ))}
          </div>
          {discovery.timings && (
            <div className="mt-1 text-xs text-muted tabular-nums">Completed in {Math.round(discovery.timings.totalMs / 1000)}s</div>
          )}
        </div>
      )}
    </div>
  );
}

function ApplyPanel({ agg, profileId, profileName, onApplied, onClose }: {
  agg: Agg; profileId: string; profileName: string;
  onApplied: () => void; onClose: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Application | null>(null);
  const [opening, setOpening] = useState(false);
  const job = agg.job || { title: agg.jobId, company: "", url: "", applyUrl: "" };

  async function createApp() {
    setCreating(true); setError("");
    const res = await fetch("/api/sc/applications", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: agg.jobId, profileId }),
    });
    const data = await res.json();
    setCreating(false);
    if (!res.ok) { setError(data.error || "Failed to create application"); return; }
    setResult(data.application);
  }

  async function openExternal() {
    setOpening(true);
    // Transition to IN_PROGRESS then ACTION_REQUIRED
    if (result) {
      await fetch("/api/sc/applications", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ applicationId: result.applicationId, status: "IN_PROGRESS", detail: "Opening application in browser" }),
      });
      await fetch("/api/sc/applications", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ applicationId: result.applicationId, status: "ACTION_REQUIRED", detail: "Application opened — complete in browser" }),
      });
    }
    // Open the actual URL
    const url = job.applyUrl || job.url;
    if (url) window.open(url, "_blank");
    setOpening(false);
    onApplied();
  }

  const applyUrl = job.applyUrl || job.url;
  const method = (() => {
    const u = (applyUrl || "").toLowerCase();
    if (u.includes("greenhouse")) return "GREENHOUSE";
    if (u.includes("workday")) return "WORKDAY";
    if (u.includes("lever")) return "LEVER";
    if (u.includes("ashby")) return "ASHBY";
    if (u.includes("linkedin")) return "LINKEDIN";
    if (u.includes("dice")) return "DICE";
    return "DIRECT_EMPLOYER";
  })();

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="text-sm font-medium text-foreground">Apply to this position</div>
      <div className="space-y-1.5 text-xs text-muted">
        <div><span className="text-foreground">Company:</span> {job.company}</div>
        <div><span className="text-foreground">Role:</span> {job.title}</div>
        <div><span className="text-foreground">Profile:</span> {profileName}</div>
        <div><span className="text-foreground">Method:</span> {methodLabel(method)}</div>
      </div>
      {error && <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
      {!result ? (
        <div className="flex flex-wrap gap-2">
          <button onClick={createApp} disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground hover:bg-brand-200 disabled:opacity-50">
            {creating ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Continue
          </button>
          <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">Cancel</button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
            Application ready. Open the employer website to complete your submission.
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={openExternal} disabled={opening}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground hover:bg-brand-200 disabled:opacity-50">
              {opening ? <Loader2 className="size-3 animate-spin" /> : <ExternalLink className="size-3" />} Open Application
            </button>
            <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">Done</button>
          </div>
          <div className="text-[11px] text-muted">
            Status: <span className="text-foreground">ACTION_REQUIRED</span> — complete the application in your browser, then return to Scavenger.
          </div>
        </div>
      )}
    </div>
  );
}

export function JobsView({ profiles }: { profiles: ProfileRef[] }) {
  const [selected, setSelected] = useState<string[]>(profiles.map((p) => p.id));
  const [results, setResults] = useState<Agg[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [companyFilter, setCompanyFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [applyingJob, setApplyingJob] = useState<string | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const load = useCallback(async () => {
    if (!selected.length) { setResults([]); setNotice("Create a profile first to search for jobs."); return; }
    setLoading(true); setNotice("");
    const q = new URLSearchParams({ profiles: selected.join(",") });
    if (companyFilter) q.set("company", companyFilter);
    if (locationFilter) q.set("location", locationFilter);
    const res = await fetch(`/api/sc/opportunities?${q.toString()}`);
    const data = await res.json();
    setLoading(false);
    if (!res.ok || data.error) { setNotice(data.error || "Search failed."); setResults([]); return; }
    setResults(data.results || []);
    if (data.empty) setNotice(data.empty);
    else if (!data.results?.length) setNotice("No jobs found yet. Run a search to discover opportunities.");
  }, [selected, companyFilter, locationFilter]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("discover") === "1" && profiles.length > 0) {
      discover();
    } else {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function discover() {
    if (!selected.length || discovering) return;
    setDiscovering(true); setDiscovery(null); setElapsed(0);
    const t0 = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    const stop = () => { clearInterval(timer); if (aliveRef.current) setDiscovering(false); };
    try {
      const started = await fetch("/api/sc/opportunities/discover", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileIds: selected }),
      });
      const created = await started.json();
      if (!started.ok || created.error || !created.runId) {
        if (aliveRef.current) setDiscovery({ status: "FAILED", error: created.error || "Could not start search" });
        stop(); return;
      }
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!aliveRef.current) return;
        const sres = await fetch(`/api/sc/opportunities/discover/${encodeURIComponent(created.runId)}`);
        const sdata = await sres.json();
        const run = sdata.run;
        if (!run) { if (aliveRef.current) setDiscovery({ status: "FAILED", error: "Search run lost" }); break; }
        if (aliveRef.current) setDiscovery({
          status: run.status, funnel: run.funnel, jobsAccepted: run.summary?.accepted,
          providers: Object.entries(run.providers || {}).map(([id, p]: [string, any]) => ({
            id, status: p.status || "QUEUED", raw: p.raw || 0, accepted: p.accepted || 0, runtimeMs: p.runtimeMs || 0,
          })),
          timings: run.timings, errors: run.errors,
        });
        if (["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"].includes(run.status)) break;
      }
    } catch {
      if (aliveRef.current) setDiscovery({ status: "FAILED", error: "Search request failed" });
    } finally {
      stop();
      if (aliveRef.current) { load(); }
    }
  }

  async function act(jobId: string, profileId: string, action: "view" | "save" | "reject") {
    await fetch("/api/sc/opportunities", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, profileId, action }),
    });
    load();
  }

  async function openDetail(jobId: string) {
    setExpanded(expanded === jobId ? null : jobId);
    if (expanded === jobId) { setDetail(null); return; }
    const d = await fetch(`/api/sc/opportunities?job=${encodeURIComponent(jobId)}&profiles=${selected.join(",")}`).then((r) => r.json());
    if (d.ok) { setDetail(d); act(jobId, d.best?.profileId || selected[0], "view"); }
  }

  const names = Object.fromEntries(profiles.map((p) => [p.id, p.name]));

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Jobs</h1>
          <p className="mt-1 text-sm text-muted">
            {profiles.length > 0 ? `Matching ${profiles.length} profile${profiles.length === 1 ? "" : "s"}` : "Create a profile to start searching"}
          </p>
        </div>
        <button onClick={() => discover()} disabled={discovering || !selected.length}
          className="orchid-cta inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition disabled:opacity-50">
          {discovering ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
          {discovering ? `Searching... ${elapsed}s` : "Search"}
        </button>
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
          <button onClick={() => setShowFilters(!showFilters)} className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
            <Filter className="size-3" /> Filters {showFilters ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        </div>
      )}

      {showFilters && (
        <div className="mt-2 flex flex-wrap gap-2">
          <input value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} placeholder="Company"
            className="w-40 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs" />
          <input value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} placeholder="Location"
            className="w-40 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs" />
          <button onClick={load} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover">Apply</button>
        </div>
      )}

      {discovering && discovery && <div className="mt-4"><DiscoveryProgress discovery={discovery} elapsed={elapsed} /></div>}
      {!discovering && discovery && discovery.status && <div className="mt-4"><DiscoveryProgress discovery={discovery} elapsed={elapsed} /></div>}

      {notice && <div className="mt-4 rounded-xl border border-border bg-surface/30 px-4 py-3 text-sm text-muted">{notice}</div>}

      {loading && <div className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Loading...</div>}

      <div className="mt-4 space-y-3">
        {results.map((a) => {
          const job = a.job || { title: a.jobId, company: "", location: "", url: "" };
          const saved = Object.values(a.history || {}).some((h) => ["saved", "applied", "interview", "offer", "hired"].includes(h.outcome || ""));
          const rejected = Object.values(a.history || {}).every((h) => h.outcome === "rejected") && Object.keys(a.history || {}).length > 0;
          if (rejected) return null;
          const isApplying = applyingJob === a.jobId;
          return (
            <div key={a.jobId} className="rounded-2xl border border-border bg-surface/30 px-5 py-4 transition-colors hover:bg-surface/50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">{job.title}</span>
                    {a.intel?.isNew && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">New</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {job.company}{job.location ? ` \u00b7 ${job.location}` : ""}
                    {job.workplaceType ? ` \u00b7 ${job.workplaceType}` : ""}
                    {job.employmentType ? ` \u00b7 ${job.employmentType}` : ""}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {a.matches.map((m) => (
                      <span key={m.profileId} className={cn("rounded-full border border-border px-2 py-0.5 text-xs tabular-nums", bandColor(m.band))}>
                        {names[m.profileId] || m.profileId}: {m.score}%
                      </span>
                    ))}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={cn("font-display text-2xl tabular-nums", bandColor(a.best.band))}>{a.best.score}<span className="text-sm text-muted">%</span></div>
                  <div className="text-xs text-muted">{bandLabel(a.best.band)}</div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <button onClick={() => setApplyingJob(isApplying ? null : a.jobId)}
                  className="inline-flex items-center gap-1 rounded-md bg-brand/10 border border-brand/30 px-2.5 py-1.5 text-brand hover:bg-brand/20">
                  <Send className="size-3" /> Apply
                </button>
                <button onClick={() => act(a.jobId, a.best.profileId, saved ? "reject" : "save")}
                  className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 hover:bg-surface-hover",
                    saved ? "text-brand border-brand/30" : "text-muted hover:text-foreground")}>
                  {saved ? <BookmarkCheck className="size-3" /> : <Bookmark className="size-3" />} {saved ? "Saved" : "Save"}
                </button>
                <button onClick={() => openDetail(a.jobId)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                  {expanded === a.jobId ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />} Why matched
                </button>
                {job.url && (
                  <a href={job.url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                    <ExternalLink className="size-3" /> View Job
                  </a>
                )}
                {saved && (
                  <button onClick={() => act(a.jobId, a.best.profileId, "reject")}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                    <X className="size-3" /> Remove
                  </button>
                )}
              </div>

              {isApplying && (
                <ApplyPanel
                  agg={a}
                  profileId={a.best.profileId || selected[0]}
                  profileName={names[a.best.profileId || selected[0]] || "Selected profile"}
                  onApplied={() => { setApplyingJob(null); load(); }}
                  onClose={() => setApplyingJob(null)}
                />
              )}

              {expanded === a.jobId && detail && (
                <div className="mt-3 space-y-3 border-t border-border pt-3">
                  {a.matches.map((m) => (
                    <div key={m.profileId}>
                      <div className="text-xs font-medium text-foreground">
                        {names[m.profileId] || m.profileId} &mdash; {m.score}% match
                      </div>
                      {m.reasons.length > 0 && (
                        <div className="mt-1">
                          <div className="text-[11px] uppercase tracking-wide text-muted mb-0.5">Why this matches</div>
                          {m.reasons.slice(0, 5).map((r, i) => (
                            <div key={i} className="text-xs text-muted flex items-start gap-1">
                              <span className="text-emerald-500 mt-0.5">\u2713</span> {r}
                            </div>
                          ))}
                        </div>
                      )}
                      {(m.penalties.length > 0 || (m.missingSignals || []).length > 0) && (
                        <div className="mt-1">
                          <div className="text-[11px] uppercase tracking-wide text-muted mb-0.5">Potential gaps</div>
                          {m.penalties.slice(0, 3).map((r, i) => (
                            <div key={i} className="text-xs text-muted flex items-start gap-1">
                              <span className="text-amber-500 mt-0.5">\u2022</span> {r}
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
        })}
      </div>
    </div>
  );
}
