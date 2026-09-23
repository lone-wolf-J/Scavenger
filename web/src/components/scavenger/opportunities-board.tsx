"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

type ProfileRef = { id: string; name: string };
type Match = {
  profileId: string;
  score: number;
  band?: { label?: string } | string;
  scoringVersion?: string;
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
  job?: { title: string; company: string; location: string; url: string; postedAt?: number; sources?: string[] } | null;
};

function bandLabel(band: Match["band"]): string {
  if (!band) return "";
  return typeof band === "string" ? band : band.label || "";
}

type ProviderRow = {
  id: string;
  status: string;
  raw: number;
  accepted: number;
  highMatch: number;
  uniqueEmployers: number;
  runtimeMs: number;
  errorTypes?: Record<string, number>;
};

type DiscoveryResult = {
  status?: string;
  error?: string;
  jobsDiscovered?: number;
  jobsAccepted?: number;
  jobsPersisted?: { added?: number; updated?: number };
  changes?: Array<{ jobId: string; changedFields: string[] }>;
  matches?: Array<{ best?: { score?: number } }>;
  funnel?: { raw: number; us: number; fresh: number; unique: number };
  providers?: ProviderRow[] | Record<string, { status?: string; raw?: number; accepted?: number; highMatch?: number; runtimeMs?: number }>;
  errors?: Array<{ provider: string; errorType: string }>;
  timings?: { totalMs: number; providerMs: number; matchingMs: number };
  runMeta?: { stage?: string; elapsed?: number };
};

function DiscoverySummary({ discovery }: { discovery: DiscoveryResult }) {
  const f = discovery.funnel;
  const added = discovery.jobsPersisted?.added ?? 0;
  const changed = (discovery.changes || []).length;
  const strong = (discovery.matches || []).filter((m) => (m.best?.score ?? 0) >= 75).length;
  const meta = (discovery.runMeta || {}) as { stage?: string; elapsed?: number };
  const inProgress = discovery.status === "QUEUED" || discovery.status === "RUNNING";
  // Providers arrive either as engine result rows or as the run-state map.
  const providerRows = Array.isArray(discovery.providers)
    ? discovery.providers.map((p) => ({
        id: p.id, status: p.status, raw: p.raw ?? 0, accepted: p.accepted ?? 0,
        highMatch: p.highMatch ?? 0, runtimeMs: p.runtimeMs ?? 0,
      }))
    : Object.entries(discovery.providers || {}).map(([id, p]) => ({
        id, status: p.status || "QUEUED", raw: p.raw ?? 0, accepted: p.accepted ?? 0,
        highMatch: p.highMatch ?? 0, runtimeMs: p.runtimeMs ?? 0,
      }));
  return (
    <div className="rounded-2xl border border-border bg-surface/30 px-5 py-4 text-sm">
      {discovery.error ? (
        <div className="text-red-600 dark:text-red-400">Discovery failed: {discovery.error}</div>
      ) : (
        <>
          <div className="font-medium text-foreground">
            {inProgress
              ? `Discovery ${discovery.status}${meta.stage ? ` — ${meta.stage}` : ""}${meta.elapsed != null ? ` (${meta.elapsed}s elapsed)` : ""}`
              : <>Discovery {discovery.status} — {discovery.jobsAccepted} opportunities found
              {` · ${added} new · ${changed} changed · ${strong} strong matches`}</>}
            {discovery.status === "PARTIAL" && <span className="text-muted"> — partially completed, some sources unavailable (see below)</span>}
            {discovery.status === "CANCELLED" && <span className="text-muted"> — cancelled by user; partial results (if any) were kept, nothing was fabricated</span>}
          </div>
          {f && (
            <div className="mt-1 text-xs text-muted tabular-nums">
              {f.raw} raw → {f.us} US → {f.fresh} fresh → {f.unique} unique → {discovery.jobsAccepted} accepted
            </div>
          )}
          <div className="mt-2 space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Provider status</div>
            {providerRows.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-x-2 text-xs tabular-nums">
                <span className={p.status === "ACTIVE" || p.status === "COMPLETE" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                  {p.status === "ACTIVE" || p.status === "COMPLETE" ? "✓" : p.status === "RUNNING" ? "…" : "✗"}
                </span>
                <span className="text-foreground">{p.id}</span>
                <span className="text-muted">{p.status}</span>
                <span className="text-muted">raw {p.raw} · acc {p.accepted} · strong {p.highMatch} · {Math.round(p.runtimeMs)}ms</span>
              </div>
            ))}
          </div>
          {(discovery.errors || []).length > 0 && (
            <div className="mt-1 text-xs text-muted">
              Unavailable: {(discovery.errors || []).map((e, i) => <span key={i}>{e.provider} ({e.errorType}){i < (discovery.errors || []).length - 1 ? " · " : ""}</span>)}
            </div>
          )}
          {discovery.timings && (
            <div className="mt-1 text-xs text-muted tabular-nums">total {Math.round(discovery.timings.totalMs)}ms (providers {Math.round(discovery.timings.providerMs)}ms, matching {Math.round(discovery.timings.matchingMs)}ms)</div>
          )}
        </>
      )}
    </div>
  );
}

export function OpportunitiesBoard({ profiles }: { profiles: ProfileRef[] }) {
  const [selected, setSelected] = useState<string[]>(profiles.map((p) => p.id));
  const [minScore, setMinScore] = useState(0);
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [results, setResults] = useState<Agg[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"all" | "new" | "changed" | "strong">("all");
  const [lifecycle, setLifecycle] = useState<"" | "active" | "stale" | "closed">("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverElapsed, setDiscoverElapsed] = useState(0);
  const [discovery, setDiscovery] = useState<Record<string, unknown> | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runHistory, setRunHistory] = useState<Array<Record<string, unknown>>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [lastRun, setLastRun] = useState<{ runId?: string; status?: string; jobsAccepted?: number; completedAt?: string } | null>(null);

  const load = useCallback(async () => {
    if (!selected.length) {
      setResults([]);
      setNotice("Select at least one profile to search.");
      return;
    }
    setLoading(true);
    setNotice("");
    const q = new URLSearchParams({ profiles: selected.join(","), minScore: String(minScore) });
    if (company) q.set("company", company);
    if (location) q.set("location", location);
    if (tab !== "all") q.set("tab", tab);
    if (lifecycle) q.set("lifecycle", lifecycle);
    const res = await fetch(`/api/sc/opportunities?${q.toString()}`);
    const data = await res.json();
    setLoading(false);
    if (!res.ok || data.error) {
      setNotice(data.error || "Search failed.");
      setResults([]);
      return;
    }
    setResults(data.results || []);
    if (data.empty) setNotice(data.empty);
    else if (!data.results?.length) setNotice("No relevant jobs found — try lowering the score floor or selecting more profiles.");
    setLastRun(data.lastRun || null);
  }, [selected, minScore, company, location, tab, lifecycle]);

  useEffect(() => {
    load();
    refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  async function act(jobId: string, profileId: string, action: "view" | "save" | "reject") {
    await fetch("/api/sc/opportunities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, profileId, action, ...(lastRun?.runId ? { discoveryRunId: lastRun.runId } : {}) }),
    });
    load();
  }

  async function discover() {
    if (!selected.length || discovering) return;
    setDiscovering(true);
    setDiscovery(null);
    setRunId(null);
    setDiscoverElapsed(0);
    const t0 = Date.now();
    const timer = setInterval(() => setDiscoverElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    const stop = () => { clearInterval(timer); if (aliveRef.current) setDiscovering(false); };
    try {
      // Async: POST returns immediately with a QUEUED runId; poll status.
      // The request is never held open for provider execution (§7).
      const started = await fetch("/api/sc/opportunities/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileIds: selected }),
      });
      const created = await started.json();
      if (!started.ok || created.error || !created.runId) {
        if (aliveRef.current) setDiscovery({ status: "FAILED", error: created.error || "could not start discovery", providers: [] });
        stop();
        return;
      }
      if (aliveRef.current) setRunId(created.runId);
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!aliveRef.current) return;
        const sres = await fetch(`/api/sc/opportunities/discover/${encodeURIComponent(created.runId)}`);
        const sdata = await sres.json();
        const run = sdata.run;
        if (!run) {
          if (aliveRef.current) setDiscovery({ status: "FAILED", error: "run disappeared", providers: [] });
          break;
        }
        if (aliveRef.current) setDiscovery(runToSummary(run));
        if (run.status === "COMPLETE" || run.status === "PARTIAL" || run.status === "FAILED" || run.status === "CANCELLED") break;
      }
    } catch {
      if (aliveRef.current) setDiscovery({ status: "FAILED", error: "discover request failed", providers: [] });
    } finally {
      stop();
      if (aliveRef.current) {
        load();
        refreshHistory();
      }
    }
    function runToSummary(run: Record<string, unknown>) {
      // Normalize persisted run state to the DiscoverySummary shape.
      return {
        status: run.status,
        providers: Object.entries((run.providers || {}) as Record<string, Record<string, unknown>>).map(([id, p]) => ({
          id,
          status: p.status || "QUEUED",
          raw: p.raw || 0,
          accepted: p.accepted || 0,
          highMatch: p.highMatch || 0,
          uniqueEmployers: 0,
          runtimeMs: p.runtimeMs || 0,
        })),
        funnel: run.funnel,
        jobsAccepted: (run.summary as Record<string, unknown> | undefined)?.accepted,
        jobsPersisted: { added: (run.summary as Record<string, unknown> | undefined)?.added ?? 0 },
        changes: [],
        matches: [],
        timings: run.timings,
        errors: run.errors,
        runMeta: { stage: run.stage, elapsed: Math.round((Date.now() - t0) / 1000) },
      };
    }
  }

  async function cancelDiscover() {
    if (!runId) return;
    try {
      await fetch(`/api/sc/opportunities/discover/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
    } catch { /* poll loop will surface the terminal state */ }
  }

  async function refreshHistory() {
    try {
      const res = await fetch("/api/sc/opportunities/discover");
      const data = await res.json();
      setRunHistory(Array.isArray((data as { asyncRuns?: unknown }).asyncRuns) ? (data.asyncRuns as Array<Record<string, unknown>>) : []);
    } catch { /* history is best-effort */ }
  }

  async function openDetail(jobId: string) {
    setExpanded(jobId);
    const d = await fetch(`/api/sc/opportunities?job=${encodeURIComponent(jobId)}&profiles=${selected.join(",")}`).then((r) => r.json());
    if (d.ok) {
      setDetail(d);
      act(jobId, d.best?.profileId || selected[0], "view");
    }
  }

  const names = Object.fromEntries(profiles.map((p) => [p.id, p.name]));

  return (
    <div className="mt-6 space-y-5">
      <div className="rounded-2xl border border-border bg-surface/30 px-5 py-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Search using</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {profiles.map((p) => (
            <label key={p.id} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(p.id)}
                onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))}
              />
              {p.name}
            </label>
          ))}
          {profiles.length === 0 && <span className="text-sm text-muted">No profiles yet — create one on the Profiles page.</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <label className="text-xs text-muted">Min score <input value={minScore} onChange={(e) => setMinScore(Number(e.target.value) || 0)} inputMode="numeric" className="ml-1 w-16 rounded-md border border-border bg-surface px-2 py-1" /></label>
          <label className="text-xs text-muted">Company <input value={company} onChange={(e) => setCompany(e.target.value)} className="ml-1 w-32 rounded-md border border-border bg-surface px-2 py-1" /></label>
          <label className="text-xs text-muted">Location <input value={location} onChange={(e) => setLocation(e.target.value)} className="ml-1 w-32 rounded-md border border-border bg-surface px-2 py-1" /></label>
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-hover">
            {loading && <Loader2 className="size-3.5 animate-spin" />} Search
          </button>
          <button onClick={discover} disabled={discovering || !selected.length} title="Run scoped live discovery for the selected profiles" className="inline-flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand/10 px-3 py-1.5 text-sm text-brand hover:bg-brand/20 disabled:opacity-50">
            {discovering && <Loader2 className="size-3.5 animate-spin" />} {discovering ? `Discovering… ${discoverElapsed}s` : "Discover new"}
          </button>
        </div>
      </div>

      {discovering && (
        <div className="rounded-2xl border border-border bg-surface/30 px-5 py-4 text-sm">
          <div className="font-medium text-foreground">Scavenger is searching…</div>
          <div className="mt-1 text-xs text-muted">Planning → searching providers → normalizing → matching. One shared retrieval for all selected profiles; {discoverElapsed}s elapsed.</div>
          <div className="mt-1 text-xs text-muted">Provider states update below as the run progresses — nothing here is estimated.</div>
          <button onClick={cancelDiscover} className="mt-2 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground">Cancel run</button>
        </div>
      )}
      {discovery && (discovery as { status?: string }).status && (
        <DiscoverySummary discovery={discovery as DiscoveryResult} />
      )}
      {runHistory.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/30 px-5 py-4 text-sm">
          <button onClick={() => setShowHistory((v) => !v)} className="text-xs font-medium uppercase tracking-wide text-muted">
            Recent runs ({runHistory.length}) {showHistory ? "▾" : "▸"}
          </button>
          {showHistory && (
            <div className="mt-2 space-y-1">
              {runHistory.map((r) => (
                <div key={String(r.runId)} className="flex flex-wrap items-center gap-x-2 text-xs tabular-nums">
                  <span className="text-foreground">{String(r.runId)}</span>
                  <span className="text-muted">{String(r.status)}{r.stage && r.stage !== r.status ? ` · ${String(r.stage)}` : ""}</span>
                  <span className="text-muted">{r.completedAt ? new Date(String(r.completedAt)).toLocaleString() : "in progress"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {notice && <div className="rounded-xl border border-border bg-surface/30 px-4 py-3 text-sm text-muted">{notice}</div>}

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "new", "changed", "strong"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full border px-3 py-1.5 text-xs capitalize ${tab === t ? "border-brand/50 bg-brand/10 text-foreground" : "border-border text-muted hover:bg-surface-hover hover:text-foreground"}`}
          >
            {t === "all" ? "All" : t === "new" ? "New" : t === "changed" ? "Changed" : "Strong matches"}
          </button>
        ))}
        {lastRun?.completedAt && (
          <span className="ml-auto text-xs text-muted">
            Last successful search {new Date(lastRun.completedAt).toLocaleString()}{lastRun.jobsAccepted != null ? `, ${lastRun.jobsAccepted} accepted` : ""}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Lifecycle:</span>
        {(["", "active", "stale", "closed"] as const).map((l) => (
          <button
            key={l || "default"}
            onClick={() => setLifecycle(l)}
            title={l === "" ? "Hide closed (default)" : l === "closed" ? "Closed jobs stay visible in history — nothing is deleted" : `Only ${l} jobs`}
            className={`rounded-full border px-3 py-1.5 text-xs capitalize ${lifecycle === l ? "border-brand/50 bg-brand/10 text-foreground" : "border-border text-muted hover:bg-surface-hover hover:text-foreground"}`}
          >
            {l === "" ? "Active (default)" : l}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {results.map((a) => {
          const job = a.job || { title: a.jobId, company: "", location: "", url: "" };
          const saved = Object.values(a.history || {}).some((h) => ["saved", "applied", "interview", "offer", "hired"].includes(h.outcome || ""));
          const viewed = Object.values(a.history || {}).some((h) => h.viewed);
          const rejected = Object.values(a.history || {}).every((h) => h.outcome === "rejected") && Object.keys(a.history || {}).length > 0;
          if (rejected) return null;
          const intel = (a as { intel?: { lifecycle?: string; isNew?: boolean; changedFields?: string[]; sources?: string[]; lastVerifiedAt?: string | null; verificationStatus?: string | null } | null }).intel;
          const verifiedLabel = intel?.lastVerifiedAt
            ? `Verified ${new Date(intel.lastVerifiedAt).toLocaleDateString()}${intel.verificationStatus && intel.verificationStatus !== "ACTIVE" ? ` · ${intel.verificationStatus}` : ""}`
            : null;
          return (
            <div key={a.jobId} className="rounded-2xl border border-border bg-surface/30 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">{job.title}</span>
                    {intel?.isNew && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">New</span>}
                    {(intel?.changedFields || []).length > 0 && (
                      <span title={`Changed: ${intel!.changedFields!.join(", ")}`} className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">Changed</span>
                    )}
                    {intel?.lifecycle && intel.lifecycle !== "active" && (
                      <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-muted">{intel.lifecycle}</span>
                    )}
                    {viewed && !saved && <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-muted">Viewed</span>}
                    {verifiedLabel && (
                      <span title={intel?.verificationStatus || "verified"} className="rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-muted">{verifiedLabel}</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{job.company}{job.location ? ` — ${job.location}` : ""}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {a.matches.map((m) => (
                      <span key={m.profileId} className="rounded-full border border-border px-2 py-0.5 text-xs tabular-nums">
                        {names[m.profileId] || m.profileId}: {m.score}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-display text-2xl tabular-nums text-landing">{a.best.score}<span className="text-sm text-muted">/100</span></div>
                  <div className="text-xs text-muted">{bandLabel(a.best.band)}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <button onClick={() => (expanded === a.jobId ? setExpanded(null) : openDetail(a.jobId))} className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                  {expanded === a.jobId ? "Hide details" : "Why matched"}
                </button>
                {job.url && <a href={job.url} target="_blank" rel="noreferrer" className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">View job</a>}
                <button onClick={() => act(a.jobId, a.best.profileId, "save")} className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">
                  {saved ? "Saved ✓" : "Save"}
                </button>
                <button onClick={() => act(a.jobId, a.best.profileId, "reject")} className="rounded-md border border-border px-2.5 py-1.5 text-muted hover:bg-surface-hover hover:text-foreground">Reject</button>
              </div>
              {expanded === a.jobId && (
                <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
                  {(() => {
                    const dj = (detail as { job?: { workplaceType?: string; employmentType?: string; salary?: { min?: number; max?: number; currency?: string } | string; lifecycle?: string; sources?: string[]; postedAt?: number; firstSeen?: number } } | null)?.job;
                    const facts: string[] = [];
                    if (dj?.workplaceType) facts.push(String(dj.workplaceType));
                    if (dj?.employmentType) facts.push(String(dj.employmentType));
                    if (dj?.salary && typeof dj.salary === "object" && dj.salary.min != null) {
                      facts.push(`${dj.salary.currency || ""} ${Number(dj.salary.min).toLocaleString()}${dj.salary.max != null ? `–${Number(dj.salary.max).toLocaleString()}` : "+"}`.trim());
                    } else if (typeof dj?.salary === "string" && dj.salary) facts.push(dj.salary);
                    if (dj?.lifecycle && dj.lifecycle !== "active") facts.push(`lifecycle: ${dj.lifecycle}`);
                    if (dj?.sources?.length) facts.push(`sources: ${dj.sources.join(", ")}`);
                    if (dj?.postedAt) facts.push(`posted ${new Date(dj.postedAt).toLocaleDateString()}`);
                    if (!facts.length) return null;
                    return <div className="text-xs text-muted">{facts.join(" · ")}</div>;
                  })()}
                  {a.matches.map((m) => {
                    const state = (detail as { history?: Record<string, { viewed?: boolean; outcome?: string }> } | null)?.history?.[m.profileId]
                      ?? a.history?.[m.profileId];
                    const stateLabel = state?.outcome && !["surfaced", "viewed"].includes(state.outcome)
                      ? state.outcome : state?.viewed ? "viewed" : null;
                    return (
                    <div key={m.profileId}>
                      <div className="text-xs font-medium text-foreground">{names[m.profileId] || m.profileId} — {m.score} [{bandLabel(m.band)}]{m.scoringVersion ? <span className="ml-1 font-normal text-muted">v{m.scoringVersion}</span> : null}{stateLabel ? <span className="ml-2 font-normal text-muted">· {stateLabel}</span> : null}</div>
                      {m.reasons.length > 0 && <div className="mt-1 text-[11px] uppercase tracking-wide text-muted">Why Scavenger thinks this fits</div>}
                      {m.reasons.slice(0, 4).map((r, i) => <div key={i} className="text-xs text-muted">+ {r}</div>)}
                      {(m.penalties.length > 0 || (m.missingSignals || []).length > 0) && <div className="mt-1 text-[11px] uppercase tracking-wide text-muted">Potential gaps</div>}
                      {m.penalties.slice(0, 3).map((r, i) => <div key={i} className="text-xs text-muted">− {r}</div>)}
                      {(m.matchedSignals || []).length > 0 && (
                        <div className="text-xs text-muted">signals: {m.matchedSignals!.slice(0, 5).join(", ")}</div>
                      )}
                      {(m.missingSignals || []).length > 0 && (
                        <div className="text-xs text-muted">missing: {m.missingSignals!.slice(0, 4).join(", ")}</div>
                      )}
                    </div>
                    );
                  })}
                  {detail && (detail as { provenance?: { sources?: string[]; originUrl?: string } }).provenance && (
                    <div className="text-xs text-muted">
                      Sources: {((detail as { provenance: { sources?: string[] } }).provenance.sources || []).join(" · ") || "—"}
                      {(detail as { job?: { postedAt?: number } }).job?.postedAt
                        ? ` · posted ${new Date((detail as { job: { postedAt: number } }).job.postedAt).toLocaleDateString()}` : ""}
                    </div>
                  )}
                  {detail && (detail as { verification?: { lastVerifiedAt?: string | null; sources?: Array<{ provider: string; status: string; checkedAt: string }> } }).verification && (
                    <div className="text-xs text-muted">
                      Verification{(() => {
                        const v = (detail as { verification: { lastVerifiedAt?: string | null; sources?: Array<{ provider: string; status: string; checkedAt: string }> } }).verification;
                        const parts = (v.sources || []).map((s) => {
                          const label = s.status === "ACTIVE" ? "Active" : s.status === "UNKNOWN" ? "Verification unavailable" : s.status;
                          const when = s.checkedAt ? ` · verified ${new Date(s.checkedAt).toLocaleDateString()}` : "";
                          return `${s.provider}: ${label}${when}`;
                        });
                        return parts.length ? `: ${parts.join(" · ")}` : ": not yet verified";
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

