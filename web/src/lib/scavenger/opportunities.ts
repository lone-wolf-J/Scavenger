// Opportunities service — canonical store × selected profiles.
//
// The shared job store (lib/job-store.mjs via repositories/job-repository)
// is the authoritative opportunity dataset (§4). Retrieval happens ONCE over
// the canonical pool; every selected profile is then matched against those
// same records via matcher.matchPool. No per-profile provider fan-out, no
// job duplication, no per-user job copies.
//
// Inbox bridge (temporary compat, documented): pipeline/inbox jobs the
// engine never observed are backfilled as NEW canonical records only —
// existing records are never touched here, so lastSeen/seenCount staleness
// signals stay intact. The inbox is not read as a pool anywhere else.

import { readInbox, careerOpsRoot } from "@/lib/career-ops";
import { loadDomainLib, scavengerPaths } from "./core";
import { getWorkspace } from "./workspace";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

export type SelectedProfile = { id: string; name: string; profile: unknown };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function toMatchableJob(inbox: {
  url: string;
  company: string;
  role: string;
  location?: string;
  compensation?: string;
  postedAt?: string;
}) {
  return {
    title: inbox.role,
    company: inbox.company,
    location: inbox.location || "",
    url: inbox.url,
    source: "inbox",
    description: "",
    postedAt: inbox.postedAt ? Date.parse(inbox.postedAt) : undefined,
  };
}

export async function getSelectedProfiles(ids?: string[]) {
  const state = await getWorkspace();
  const active = (state.profiles || []).filter((p: Any) => p.state === "active");
  const want = ids && ids.length ? new Set(ids) : new Set(state.selectedProfileIds || active.map((p: Any) => p.id));
  return active
    .filter((p: Any) => want.has(p.id))
    .map((p: Any) => ({ id: p.id, name: p.name, profile: p.profile }));
}

export async function getSearchIntent(profiles: SelectedProfile[]) {
  const si = await loadDomainLib("search-intent");
  return si.buildSearchIntent(profiles .map((p: SelectedProfile) => ({ id: p.id, profile: p.profile })));
}

/** Inbox read: used ONLY as backfill source for jobs discovery never saw. */
function readInboxJobs(): Any[] {
  try {
    return readInbox().filter((j) => !j.done).map(toMatchableJob);
  } catch {
    return [];
  }
}

export async function getOpportunities(opts: {
  profileIds?: string[];
  minScore?: number;
  filters?: Record<string, unknown>;
}) {
  const profiles = await getSelectedProfiles(opts.profileIds);
  if (!profiles.length) {
    return { ok: false as const, error: "no active profiles selected — create or select a profile first" };
  }
  // Canonical pool (Phase 7 §4): the shared job store is authoritative.
  // Inbox bridge (temporary compat): pipeline jobs never seen by discovery
  // are backfilled as NEW records only — existing records are never touched
  // here, so lastSeen/seenCount staleness signals stay intact. The inbox is
  // not read as a pool anywhere else in this service.
  const jobRepo = await loadDomainLib("repositories/job-repository");
  const { dir } = scavengerPaths();
  const jobs = jobRepo.openJobRepository(`${dir}/job-store.json`);
  const inbox = readInboxJobs();
  const haveUrls = new Set<string>();
  for (const rec of jobs.list() as Any[]) {
    for (const u of [(rec as Any).url, ...(((rec as Any).urls || []) as string[])]) {
      if (typeof u === "string" && u) haveUrls.add(u);
    }
  }
  const missing = inbox.filter((j: Any) => j.url && !haveUrls.has(j.url));
  if (missing.length) jobs.upsert(missing.map((j: Any) => ({ ...j, source: "inbox" })));
  let pool = (jobs.list() as Any[]).filter((r) => r && typeof r === "object");
  if (pool.length && !(opts.filters || {}).lifecycle) {
    // Closed jobs stay out of the default feed; lifecycle=closed|stale|active
    // (or saved/history views) still reaches them.
    pool = pool.filter((r) => (r.lifecycle || "active") !== "closed");
  }
  if (!pool.length) {
    return {
      ok: true as const,
      profiles: profiles .map((p: SelectedProfile) => ({ id: p.id, name: p.name })),
      intent: await getSearchIntent(profiles),
      results: [],
      empty: "No jobs in discovery yet — run Discover above or add job URLs to the pipeline first.",
    };
  }
  const matcher = await loadDomainLib("matcher");
  const aggregated = matcher.matchPool(
    pool,
    profiles .map((p: SelectedProfile) => ({ id: p.id, profile: p.profile })),
    { minScore: opts.minScore ?? 0 },
  );
  // Remap match ids to canonical keys (mirror lib/discovery-engine.mjs):
  // matchJob ids are source-scoped; store/history/saved keys are canonical.
  const jm = await loadDomainLib("job-model");
  const jd = await loadDomainLib("job-dedup");
  const now = Date.now();
  const canonByMatchId = new Map<string, string>();
  for (const u of pool) {
    try {
      const matchId = jm.normalizeJob(u, u.source || "unknown", now).id;
      canonByMatchId.set(matchId, jd.canonicalJobKey(u) || matchId);
    } catch { /* keep source-scoped id */ }
  }
  for (const agg of aggregated as Any[]) {
    const canonical = canonByMatchId.get(agg.jobId);
    if (canonical) {
      agg.jobId = canonical;
      for (const m of agg.matches || []) m.jobId = canonical;
    }
  }
  const of = await loadDomainLib("opportunity-filters");
  // Dual-key index: aggregated jobIds are remapped to RECOMPUTED canonical
  // keys, but stored record ids stay stable across title/date refinements
  // (upsertJobs preserves keys so saved refs never break). Index both so the
  // join below and lifecycle filters survive stale stored ids.
  const jobsById = new Map<string, Any>();
  for (const j of pool as Any[]) {
    try {
      const canon = (jd as Any).canonicalJobKey(j);
      if (typeof canon === "string" && canon && !jobsById.has(canon)) jobsById.set(canon, j);
    } catch { /* keep stored-id key only */ }
  }
  for (const j of pool as Any[]) {
    if (j && typeof j.jobId === "string") jobsById.set(j.jobId, j);
  }
  const runs = await getDiscoveryRuns();
  // "Since your last search": new = first seen after the previous run.
  // With a single run on record, recent discoveries (≤14d) count as new.
  const prevCompleted = runs.length > 1 && runs[1]?.completedAt ? Date.parse(runs[1].completedAt) : null;
  const isNewRecord = (rec: Any) => {
    if (typeof rec.firstSeen !== "number") return false;
    if (prevCompleted != null) return rec.firstSeen > prevCompleted;
    return Date.now() - rec.firstSeen <= 14 * 86_400_000;
  };
  const effectiveFilters = { ...(opts.filters || {}) } as Record<string, unknown>;
  const wantNew = effectiveFilters.isNew === true;
  delete effectiveFilters.isNew;
  delete effectiveFilters.sinceRunAt;
  let results = of.filterOpportunities(aggregated, effectiveFilters, jobsById);
  if (wantNew) {
    results = results.filter((agg: Any) => {
      const rec = jobsById.get(agg.jobId);
      return !rec || isNewRecord(rec);
    });
  }
  // Join history flags (viewed/saved) without duplicating job records.
  // Canonical keys first, legacy `inbox:url` keys as fallback (pre-Phase-7
  // entries migrate lazily on write in recordJobEvent).
  const matchRepo = await loadDomainLib("repositories/match-repository");
  const { history: historyPath } = scavengerPaths();
  const history = matchRepo.openMatchRepository(historyPath).load();
  const withFlags = results.map((agg: Any) => {
    const flags: Record<string, Any> = {};
    const rec = jobsById.get(agg.jobId) as Any;
    for (const m of agg.matches || []) {
      const entry = history.matches?.[`${m.profileId}::${agg.jobId}`]
        || (rec?.url ? history.matches?.[`${m.profileId}::inbox:${rec.url}`] : null);
      if (entry) flags[m.profileId] = { viewed: entry.viewed, outcome: entry.outcome };
    }
    const verification = verificationSummary(rec || {});
    const latestSource = [...verification.sources].sort((a, b) => (a.checkedAt < b.checkedAt ? 1 : -1))[0] || null;
    return {
      ...agg,
      history: flags,
      intel: rec
        ? {
            lifecycle: rec.lifecycle || "active",
            isNew: isNewRecord(rec),
            changedFields: rec.lastChangedFields || [],
            firstSeen: rec.firstSeen ?? null,
            sources: rec.sources || [],
            lastVerifiedAt: verification.lastVerifiedAt,
            verificationStatus: latestSource ? latestSource.status : null,
          }
        : null,
    };
  });
  const successful = runs.find((r: Any) => r?.status === "COMPLETE") || null;
  const intent = await getSearchIntent(profiles);
  const resultsWithJobs = withFlags.map((agg: Any) => ({ ...agg, job: jobsById.get(agg.jobId) || null }));
  return {
    ok: true as const,
    profiles: profiles .map((p: SelectedProfile) => ({ id: p.id, name: p.name })),
    intent: { queries: intent.queries, byProfile: intent.byProfile.map((b: Any) => ({ profileId: b.profileId, families: b.families.length })) },
    results: resultsWithJobs,
    poolSize: pool.length,
    lastRun: successful
      ? { runId: successful.runId, completedAt: successful.completedAt, status: successful.status, jobsAccepted: successful.jobsAccepted }
      : null,
  };
}

export async function getJobDetail(jobId: string, profileIds?: string[]) {
  const profiles = await getSelectedProfiles(profileIds);
  const jobRepo = await loadDomainLib("repositories/job-repository");
  const { dir } = scavengerPaths();
  const jobs = jobRepo.openJobRepository(`${dir}/job-store.json`);
  // Canonical record first (stored id); legacy `inbox:url` ids resolve via
  // URL index. Stored ids stay stable across refinements, so fall back to a
  // recomputed-canonical scan before 404ing.
  let job: Any | null = jobs.get(jobId);
  if (!job) {
    try {
      const jd = await loadDomainLib("job-dedup");
      job = (jobs.list() as Any[]).find((r: Any) => {
        try { return (jd as Any).canonicalJobKey(r) === jobId; } catch { return false; }
      }) || null;
    } catch { /* exact miss stands */ }
  }
  if (!job && jobId.startsWith("inbox:")) {
    const url = jobId.slice("inbox:".length);
    job = jobs.list().find((r: Any) => r.url === url || (r.urls || []).includes(url)) || null;
  }
  if (!job) return { ok: false as const, error: "job not in the shared pool" };
  const matcher = await loadDomainLib("matcher");
  const jm = await loadDomainLib("job-model");
  const aggregated = matcher.matchJobMany(job, profiles .map((p: SelectedProfile) => ({ id: p.id, profile: p.profile })));
  const provenance = jm.jobProvenance(job);
  // Per-profile user state (§20): outcomes are keyed profileId::jobId, so the
  // detail view can show that Profile A saved what Profile B rejected.
  let history: Record<string, { viewed?: boolean; outcome?: string }> = {};
  try {
    const mh = await loadDomainLib("match-history");
    const matchRepo = await loadDomainLib("repositories/match-repository");
    const { history: historyPath } = scavengerPaths();
    const view = mh.getJobView(matchRepo.openMatchRepository(historyPath).load(), {
      jobId: job.jobId || jobId,
      profileIds: profiles .map((p: SelectedProfile) => p.id),
    });
    for (const [pid, v] of Object.entries((view?.profiles || {}) as Record<string, Any>)) {
      history[pid] = { viewed: !!(v as Any)?.viewed, outcome: typeof (v as Any)?.outcome === "string" ? (v as Any).outcome : undefined };
    }
  } catch { /* history is best-effort; detail works without it */ }
  return { ok: true as const, job, provenance, matches: aggregated.matches, best: aggregated.best, verification: verificationSummary(job), history };
}

/** Compact per-source verification state for UI display. No raw bodies, no internal errors. */
function verificationSummary(job: Any): {
  lastVerifiedAt: string | null;
  lifecycle: string;
  sources: Array<{ provider: string; status: string; checkedAt: string; evidenceType: string | null }>;
} {
  const bySource = (job?.verificationBySource && typeof job.verificationBySource === "object") ? job.verificationBySource : {};
  const sources = Object.entries(bySource).map(([provider, v]: [string, Any]) => ({
    provider,
    status: typeof v?.status === "string" ? v.status : "UNKNOWN",
    checkedAt: typeof v?.checkedAt === "string" ? v.checkedAt : "",
    evidenceType: typeof v?.evidenceType === "string" ? v.evidenceType : null,
  }));
  if (!sources.length && Array.isArray(job?.verificationHistory)) {
    // Backfill view for records verified before the per-source map existed.
    const latest = new Map<string, Any>();
    for (const e of job.verificationHistory) {
      if (e && typeof e.provider === "string" && e.provider) latest.set(e.provider, e);
    }
    for (const [provider, e] of latest) {
      sources.push({
        provider,
        status: typeof e?.status === "string" ? e.status : "UNKNOWN",
        checkedAt: typeof e?.checkedAt === "string" ? e.checkedAt : "",
        evidenceType: typeof e?.evidence?.type === "string" ? e.evidence.type : null,
      });
    }
  }
  sources.sort((a, b) => (a.provider < b.provider ? -1 : 1));
  return {
    lastVerifiedAt: typeof job?.lastVerifiedAt === "string" ? job.lastVerifiedAt : null,
    lifecycle: typeof job?.lifecycle === "string" ? job.lifecycle : "active",
    sources,
  };
}

export async function recordJobEvent(
  jobId: string,
  profileId: string,
  action: "view" | "save" | "reject",
  opts?: { discoveryRunId?: string },
) {
  const matchRepo = await loadDomainLib("repositories/match-repository");
  const { history: historyPath } = scavengerPaths();
  const repo = matchRepo.openMatchRepository(historyPath);
  const history = repo.load();
  // Lazy legacy migration: pre-Phase-7 `profileId::inbox:url` entries move
  // to canonical keys via the store URL index (migrateLegacyKeys never
  // overwrites; reads elsewhere also keep a fallback).
  const mh = await loadDomainLib("match-history");
  const jobRepo = await loadDomainLib("repositories/job-repository");
  const jd = await loadDomainLib("job-dedup");
  const { dir } = scavengerPaths();
  const urlToCanonical = new Map<string, string>();
  for (const rec of jobRepo.openJobRepository(`${dir}/job-store.json`).list() as Any[]) {
    for (const u of [rec.url, ...(rec.urls || [])]) {
      if (typeof u !== "string" || !u) continue;
      if (!urlToCanonical.has(u)) urlToCanonical.set(u, rec.jobId);
      try {
        const norm = jd.normalizeJobUrl(u);
        if (norm && !urlToCanonical.has(norm)) urlToCanonical.set(norm, rec.jobId);
      } catch { /* keep raw-only mapping */ }
    }
  }
  mh.migrateLegacyKeys(history, urlToCanonical);
  const key = `${profileId}::${jobId}`;
  if (!history.matches?.[key]) {
    // First touch: record a lightweight entry so save/reject never requires
    // a prior full match (score fills in on the next opportunities load).
    history.matches = history.matches || {};
    const stamp = new Date().toISOString();
    history.matches[key] = {
      jobId, profileId, score: null, band: null, reasons: [], penalties: [],
      matchedSignals: [], missingSignals: [], jobHash: "", profileHash: "",
      scoreChanged: false, jobChanged: false, profileChanged: false,
      viewed: false, viewedAt: null, outcome: "surfaced", outcomeAt: stamp,
      createdAt: stamp, updatedAt: stamp,
    };
  }
  let entry;
  if (action === "view") entry = mh.markViewed(history, { jobId, profileId });
  else entry = mh.recordOutcome(history, { jobId, profileId, outcome: action === "save" ? "saved" : "rejected" }).entry;
  // discoveryRunId propagation (§14): stamp set-once, mirroring recordMatch —
  // the first touch attributes the outcome; later touches never rewrite it.
  if (opts?.discoveryRunId && entry && !entry.discoveryRunId) {
    entry.discoveryRunId = opts.discoveryRunId;
    entry.updatedAt = new Date().toISOString();
  }
  repo.save(history);
  return { ok: true as const, entry };
}

export async function getSaved() {
  const matchRepo = await loadDomainLib("repositories/match-repository");
  const { history: historyPath } = scavengerPaths();
  const history = matchRepo.openMatchRepository(historyPath).load();
  // Canonical join (Phase 7 §4, §7): saved entries reference the ONE shared
  // record. Legacy `inbox:url` entries resolve through the same URL index;
  // closed jobs remain visible here — history is never lost to lifecycle.
  const jobRepo = await loadDomainLib("repositories/job-repository");
  const { dir } = scavengerPaths();
  const byId = new Map<string, Any>();
  const byUrl = new Map<string, Any>();
  for (const rec of jobRepo.openJobRepository(`${dir}/job-store.json`).list() as Any[]) {
    byId.set(rec.jobId, rec);
    for (const u of [rec.url, ...(rec.urls || [])]) {
      if (typeof u === "string" && u) {
        if (!byUrl.has(u)) byUrl.set(u, rec);
        if (!byUrl.has(`inbox:${u}`)) byUrl.set(`inbox:${u}`, rec);
      }
    }
  }
  const state = await getWorkspace();
  const names = new Map((state.profiles || []).map((p: Any) => [p.id, p.name]));
  return Object.values(history.matches || {})
    .filter((e: Any) => ["saved", "applied", "interview", "offer", "hired"].includes(e.outcome))
    .map((e: Any) => ({
      ...e,
      profileName: names.get(e.profileId) || e.profileId,
      job: byId.get(e.jobId) || byUrl.get(e.jobId) || null,
    }))
    .sort((a: Any, b: Any) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * Live scoped discovery for selected profiles (Phase 5 §1–4).
 * Thin wrapper over lib/discovery-engine.mjs: same engine the CLI uses.
 * Options validated by the engine (US-only location, 1/3/7/14 freshness,
 * bounded queries/providers). Synchronous — the UI shows staged progress
 * while awaiting the response; no queue infrastructure.
 */
export async function runDiscovery(opts: {
  profileIds?: string[];
  maxAgeDays?: number;
  maxQueries?: number;
  providers?: string[];
  refresh?: boolean;
}) {
  const profiles = await getSelectedProfiles(opts.profileIds);
  if (!profiles.length) {
    return { ok: false as const, error: "no active profiles selected — create or select a profile first" };
  }
  const engine = await loadDomainLib("discovery-engine");
  try {
    const result = await engine.discoverForProfiles({
      profiles: profiles.map((p: SelectedProfile) => ({ id: p.id, profile: p.profile })),
      providers: opts.providers,
      maxAgeDays: opts.maxAgeDays,
      maxQueries: opts.maxQueries,
      refresh: opts.refresh,
      dataRoot: careerOpsRoot(),
    });
    return { ok: true as const, result };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false as const, error: err.message || "discovery failed", code: err.code || "ERROR" };
  }
}

export async function getDiscoveryRuns() {
  const engine = await loadDomainLib("discovery-engine");
  const { dir } = scavengerPaths();
  const runs = engine.readDiscoveryRuns(`${dir}/discovery-runs.json`);
  return runs.slice(-10).reverse();
}

// ---------------------------------------------------------------------------
// Async discovery runs (Phase 8 §7–10): POST returns immediately with a
// QUEUED runId; a detached worker executes the shared engine; the client
// polls run status. CLI keeps the synchronous path above untouched.
// ---------------------------------------------------------------------------

function asyncRunsDir(): string {
  const { dir } = scavengerPaths();
  return path.join(dir, "runs");
}

function idempotencyKey(profileIds: string[], opts: Record<string, unknown>): string {
  const norm = {
    profiles: [...profileIds].sort(),
    providers: Array.isArray(opts.providers) ? [...(opts.providers as string[])].sort() : null,
    maxAgeDays: opts.maxAgeDays ?? null,
    maxQueries: opts.maxQueries ?? null,
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
}

export async function startDiscoveryRun(opts: {
  profileIds?: string[];
  maxAgeDays?: number;
  maxQueries?: number;
  providers?: string[];
  refresh?: boolean;
}) {
  const profiles = await getSelectedProfiles(opts.profileIds);
  if (!profiles.length) {
    return { ok: false as const, error: "no active profiles selected — create or select a profile first" };
  }
  const asyncRepo = await loadDomainLib("repositories/async-run-repository");
  const dir = asyncRunsDir();
  const key = idempotencyKey(
    profiles.map((p: SelectedProfile) => p.id),
    opts as Record<string, unknown>,
  );
  const existing = asyncRepo.openAsyncRunRepository(dir).findActiveByKey(key);
  if (existing) return { ok: true as const, runId: existing.runId, status: existing.status, deduped: true };
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const repos = asyncRepo.openAsyncRunRepository(dir);
  repos.create({
    runId,
    profiles: profiles.map((p: SelectedProfile) => ({ id: p.id, name: p.name })),
    options: {
      maxAgeDays: opts.maxAgeDays,
      maxQueries: opts.maxQueries,
      providers: opts.providers,
      refresh: opts.refresh === true,
    },
    idempotencyKey: key,
  });
  writeFileSync(
    repos.inputPath(runId),
    JSON.stringify({
      profiles: profiles.map((p: SelectedProfile) => ({ id: p.id, profile: p.profile })),
      options: {
        maxAgeDays: opts.maxAgeDays,
        maxQueries: opts.maxQueries,
        providers: opts.providers,
        refresh: opts.refresh === true,
      },
      dataRoot: careerOpsRoot(),
      jobStorePath: path.join(dir, "..", "job-store.json"),
      runsPath: path.join(dir, "..", "discovery-runs.json"),
      userId: "local",
    }),
  );
  const workerPath = path.join(careerOpsRoot(), "lib", "discovery-worker.mjs");
  const child = spawn(process.execPath, [workerPath, dir, runId], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  return { ok: true as const, runId, status: "QUEUED", deduped: false };
}

export async function getAsyncRun(runId: string) {
  const asyncRepo = await loadDomainLib("repositories/async-run-repository");
  const repos = asyncRepo.openAsyncRunRepository(asyncRunsDir());
  // Recovery on read (§22): a RUNNING run whose worker died (or heartbeat
  // stale) is marked FAILED recoverable — never silently restarted.
  repos.recover(Date.now());
  const run = repos.get(String(runId));
  if (!run) return { ok: false as const, error: "unknown run" };
  return { ok: true as const, run };
}

export async function cancelAsyncRun(runId: string) {
  const asyncRepo = await loadDomainLib("repositories/async-run-repository");
  const repos = asyncRepo.openAsyncRunRepository(asyncRunsDir());
  const run = repos.get(String(runId));
  if (!run) return { ok: false as const, error: "unknown run" };
  if (run.status === "QUEUED") {
    repos.transition(runId, "CANCELLED", { stage: "CANCELLED", completedAt: new Date().toISOString() });
    return { ok: true as const, status: "CANCELLED" };
  }
  if (run.status === "RUNNING") {
    // The worker polls cancelRequested between provider executions.
    repos.update(runId, { cancelRequested: true });
    return { ok: true as const, status: "RUNNING", cancelRequested: true };
  }
  return { ok: false as const, error: `run is already ${run.status}` };
}

export async function listAsyncRuns(limit = 20) {
  const asyncRepo = await loadDomainLib("repositories/async-run-repository");
  return asyncRepo.openAsyncRunRepository(asyncRunsDir()).list(limit);
}


