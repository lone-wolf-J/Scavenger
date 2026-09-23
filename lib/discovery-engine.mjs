// Discovery engine — shared scoped job discovery for CLI and Web (§22).
//
// discoverForProfiles() runs the full pipeline with the SAME domain libs
// the scanner uses, minus the CLI coupling (no portals.yml, no pipeline.md,
// no tracker writes):
//
//   intent → deduped queries → scoped provider execution → normalize →
//   US-only → freshness → canonical dedup → job-store upsert →
//   employer resolution → match selected profiles → structured result
//
// Safety: provider ids must exist in the registry (unknown ids are rejected,
// never fetched); locations must be US (or the default); numeric options are
// bounded; providers build their own URLs from {query, location} — user
// input never becomes a fetched URL (existing SSRF guards stay in force).

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadProviders } from '../providers/_registry.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';
import { runProvider } from './provider-result.mjs';
import { loadCache, isFresh, recordSuccess, recordFailure, cacheScope, DEFAULT_TTL_MS } from './provider-cache.mjs';
import { normalizeProviderJob, normalizeJob } from './job-model.mjs';
import { normalizeCareerProfile } from './career-profile.mjs';
import { buildSearchIntent } from './search-intent.mjs';
import { familyQuery } from './search-generation.mjs';
import { classifyUsLocation } from './us-location.mjs';
import { canonicalJobKey, mergeIntoCanonical, normalizeJobUrl } from './job-dedup.mjs';
import { emptyStore, loadStore, saveStore, upsertJobs } from './job-store.mjs';
import { openJobRepository } from './repositories/job-repository.mjs';
import { openDiscoveryRunRepository } from './repositories/discovery-run-repository.mjs';
import { applyLiveness, assertClosedEvidence, safeForClosure } from './job-liveness.mjs';
import { aggregateDiscovery } from './employer-discovery.mjs';
import { diffJobs, refreshLifecycle } from './job-diff.mjs';
import { enrichDecision } from './employer-evidence.mjs';
import { normalizeCompanyIdentity } from './company-normalize.mjs';
import { matchPool } from './matcher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROVIDERS_DIR = join(HERE, '..', 'providers');

export const DEFAULT_BOARD_PROVIDERS = [
  // Query-scoped boards (honor entry.query): dice + linkedin work from most
  // networks; indeed/careerbuilder/monster/ziprecruiter/techfetch are kept for
  // fail-fast telemetry — they 403 from bot-filtered networks and contribute
  // nothing there, but recover automatically where reachable.
  'dice', 'linkedin', 'wellfound',
  'indeed', 'careerbuilder', 'monster', 'ziprecruiter', 'techfetch',
  // Board-wide feeds (query-agnostic — each returns the board's latest, so
  // every query execution re-fetches the same feed; canonical dedup collapses
  // the dupes downstream and the 30-min provider cache absorbs repeat runs).
  // Remote-first boards with real non-engineering volume (marketing, support,
  // design, content). themuse/remotli/hackernews are deliberately excluded:
  // unfiltered multi-thousand-job dumps that bloat the funnel without signal.
  'remotive', 'weworkremotely', 'remoteok', 'himalayas',
];
export const DEFAULT_LOCATION = 'United States';
export const DEFAULT_MAX_AGE_DAYS = 7;
export const ALLOWED_AGES = new Set([1, 3, 7, 14]);
export const DEFAULT_MAX_QUERIES = 6;
export const MAX_QUERIES_HARD = 12;
export const PROVIDER_CONCURRENCY = 4;
export const CACHE_TTL_MS = DEFAULT_TTL_MS;

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Location must be US (or empty → default). Anything else is rejected, never fetched. */
export function validateDiscoveryLocation(location) {
  const loc = String(location || '').trim() || DEFAULT_LOCATION;
  if (/\bcanada\b/i.test(loc) && !/\bunited states\b|\bUSA?\b/i.test(loc)) {
    throw discoveryError('INVALID_LOCATION', `location "${loc}" is not US-only`);
  }
  if (!/\bunited states\b|\bUSA?\b/i.test(loc)) {
    throw discoveryError('INVALID_LOCATION', `location "${loc}" must be US (e.g. "United States")`);
  }
  return loc;
}

export function discoveryError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Explicit provider state for discovery results (mirrors scan.mjs semantics). */
export function discoveryProviderStatus({ succeeded, failed, lastErrorType }) {
  if (succeeded > 0) return 'ACTIVE';
  if (failed === 0) return 'ACTIVE';
  if (lastErrorType === 'UNSUPPORTED') return 'UNSUPPORTED';
  if (lastErrorType === 'BLOCKED') return 'BLOCKED';
  if (lastErrorType === 'REQUIRES_AUTH') return 'AUTH_REQUIRED';
  if (lastErrorType === 'RATE_LIMITED') return 'RATE_LIMITED';
  if (lastErrorType === 'UNAVAILABLE') return 'TEMPORARILY_UNAVAILABLE';
  return 'ERROR';
}

/** Bounded worker pool preserving input order. */
export async function poolAll(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function readRuns(runsPath) {
  if (!runsPath) return [];
  return openDiscoveryRunRepository(runsPath).load().runs;
}

function writeRuns(runsPath, runs) {
  if (!runsPath) return;
  const repo = openDiscoveryRunRepository(runsPath);
  const state = repo.load();
  state.runs = runs.slice(-50);
  repo.save(state);
}

/**
 * @param {object} opts
 * @param {Array<{id: string, profile: object}>} opts.profiles - validated Career Profiles (≥1)
 * @param {string[]} [opts.providers] - allowlisted provider ids (default US boards)
 * @param {string} [opts.location] - must be US (default "United States")
 * @param {number} [opts.maxAgeDays] - one of 1/3/7/14 (default 7)
 * @param {number} [opts.maxQueries] - 1..12 (default 6)
 * @param {number} [opts.maxPages] - per-provider page hint
 * @param {string} [opts.dataRoot] - cache + job-store + runs live here
 * @param {string} [opts.jobStorePath] - overrides {dataRoot}/data/scavenger/job-store.json
 * @param {string} [opts.runsPath] - overrides {dataRoot}/data/scavenger/discovery-runs.json
 * @param {boolean} [opts.refresh] - bypass cache
 * @param {boolean} [opts.dryRun] - fetch+compute, persist nothing
 * @param {Record<string, object>} [opts.closedEvidence] - jobId-or-URL → closedEvidence
 *   (validated schema; invalid entries are reported, never applied)
 * @param {Map} [opts.providerModules] - injected id→provider (tests); else loaded from providersDir
 * @param {string} [opts.providersDir] - provider registry dir
 * @param {number} [opts.now] - injectable clock
 * @param {(info: {stage: string, elapsedMs: number}) => void} [opts.onProgress] -
 *   stage callback (SEARCHING/NORMALIZING/MATCHING); never throws into discovery
 * @param {() => boolean} [opts.cancelCheck] - polled before each provider
 *   execution; truthy aborts with a CANCELLED error
 */
export async function discoverForProfiles(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const t = { planning: 0, providers: 0, normalize: 0, dedup: 0, persist: 0, matching: 0 };
  const t0 = Date.now();
  const runId = uid('run');
  const startedAt = new Date(now).toISOString();

  // ---- validate (safety §24; no fetch happens before this passes) ----
  const profiles = (Array.isArray(opts.profiles) ? opts.profiles : [])
    .map((p) => ({ id: String(p?.id || ''), profile: normalizeCareerProfile(p?.profile || p) }))
    .filter((p) => p.id);
  if (!profiles.length) throw discoveryError('NO_PROFILES', 'at least one profile with an id is required');
  for (const p of profiles) {
    if (!p.profile.targetRoles.length) {
      throw discoveryError('PROFILE_WITHOUT_TARGETS', `profile "${p.id}" has no target roles — nothing to search for`);
    }
  }
  const location = validateDiscoveryLocation(opts.location);
  const maxAgeDays = opts.maxAgeDays == null ? DEFAULT_MAX_AGE_DAYS : Number(opts.maxAgeDays);
  if (!ALLOWED_AGES.has(maxAgeDays)) throw discoveryError('INVALID_FRESHNESS', 'maxAgeDays must be one of 1, 3, 7, 14');
  const maxQueries = opts.maxQueries == null ? DEFAULT_MAX_QUERIES : Number(opts.maxQueries);
  if (!Number.isInteger(maxQueries) || maxQueries < 1 || maxQueries > MAX_QUERIES_HARD) {
    throw discoveryError('INVALID_QUERY_LIMIT', 'maxQueries must be an integer 1..12');
  }

  // ---- providers: registry ids only, unknown rejected ----
  const providerModules = opts.providerModules || await loadProviders(opts.providersDir || DEFAULT_PROVIDERS_DIR);
  const wanted = Array.isArray(opts.providers) && opts.providers.length ? opts.providers : DEFAULT_BOARD_PROVIDERS;
  const unknown = wanted.filter((id) => !providerModules.has(id));
  if (unknown.length) throw discoveryError('UNKNOWN_PROVIDER', `unknown provider(s): ${unknown.join(', ')}`);
  const providers = wanted.map((id) => providerModules.get(id));

  // ---- planning: intent → merged deduped queries ----
  const intent = buildSearchIntent(profiles.map((p) => ({ id: p.id, profile: p.profile })));
  const queries = [...new Set(intent.queries.map((q) => q.trim()).filter((q) => q && q.length <= 200))].slice(0, maxQueries);
  if (!queries.length) throw discoveryError('NO_QUERIES', 'no search queries could be derived from the selected profiles');
  t.planning = Date.now() - t0;
  // Query→family index (§14): which search family produced each merged query
  // (first family wins on cross-family dedupe collisions). Tags retrieval so
  // family performance is measurable, never to change retrieval.
  const familyByQuery = new Map();
  for (const { families } of intent.byProfile || []) {
    for (const family of families || []) {
      if (!family || typeof family.name !== 'string') continue;
      for (const q of [familyQuery(family, { withBoosters: 1 }), familyQuery(family, { withBoosters: 0 })]) {
        const key = String(q || '').trim();
        if (key && !familyByQuery.has(key)) familyByQuery.set(key, family.name);
      }
    }
  }
  // Per-(provider, query) retrieval counters for queryStats (§12–14).
  const queryStats = new Map();
  const statQuery = (provider, query) => {
    const key = `${provider}	${query}`;
    if (!queryStats.has(key)) {
      queryStats.set(key, { provider, query, family: familyByQuery.get(String(query).trim()) || null, retrieved: 0, normalized: 0, accepted: 0 });
    }
    return queryStats.get(key);
  };
  // Retrieval-stage tracing (§6, Phase 12): opt-in per-URL presence tracking
  // so one evaluation case can show the first stage at which an opportunity
  // disappeared. Zero overhead when opts.traceUrls is absent.
  const traceKeyOf = (url) => {
    try { return normalizeJobUrl(url) || String(url || ''); } catch { return String(url || ''); }
  };
  const traceWanted = new Set(
    (Array.isArray(opts.traceUrls) ? opts.traceUrls : []).map(traceKeyOf).filter(Boolean),
  );
  const traces = new Map();
  for (const key of traceWanted) {
    traces.set(key, {
      url: key, queries: [], providers: [],
      retrieved: false, normalized: false, usAccepted: false, fresh: false,
      canonical: false, matchedBest: null, matchedBand: null, lossReason: null,
    });
  }
  const traceMark = (url, stage, info = {}) => {
    if (!traceWanted.size) return;
    const key = traceKeyOf(url);
    const t = traces.get(key);
    if (!t) return;
    if (info.query && !t.queries.includes(info.query)) t.queries.push(info.query);
    if (info.provider && !t.providers.includes(info.provider)) t.providers.push(info.provider);
    if (stage === 'retrieved') t.retrieved = true;
    else if (stage === 'normalized') t.normalized = true;
    else if (stage === 'us') { t.usAccepted = true; }
    else if (stage === 'fresh') t.fresh = true;
    else if (stage === 'canonical') { t.canonical = true; t.canonicalKey = info.canonicalKey || t.canonicalKey || null; }
    else if (stage === 'matched') { t.matchedBest = info.score; t.matchedBand = info.band; }
    else if (stage === 'loss' && !t.lossReason) t.lossReason = info.reason || 'unknown';
  };

  // ---- scoped execution: one entry per (provider, query); sequential per
  // provider (rate limits), bounded concurrency across providers ----
  const dataRoot = opts.dataRoot || null;
  const tp = Date.now();
  const ctx = { ...makeHttpCtx(), maxPages: opts.maxPages };
  // Progress hook for async runners (no-op when absent): stage-level only,
  // never per-job. Stages: SEARCHING → NORMALIZING → MATCHING.
  const reportStage = (stage, extra = {}) => {
    try {
      opts.onProgress?.({ stage, elapsedMs: Date.now() - t0, ...extra });
    } catch { /* progress must never break discovery */ }
  };
  const executions = [];
  for (const provider of providers) {
    for (const query of queries) {
      executions.push({
        provider,
        entry: { name: `discovery:${provider.id}`, provider: provider.id, query, location },
        query,
        family: familyByQuery.get(query) || null,
      });
    }
  }
  const byProvider = new Map();
  for (const ex of executions) {
    if (!byProvider.has(ex.provider.id)) byProvider.set(ex.provider.id, []);
    byProvider.get(ex.provider.id).push(ex);
  }
  const providerStats = new Map();
  const statFor = (id) => {
    if (!providerStats.has(id)) {
      providerStats.set(id, {
        id, requested: 0, succeeded: 0, failed: 0, errorTypes: {}, lastErrorType: '',
        raw: 0, normalized: 0, us: 0, fresh: 0, accepted: 0, dupes: 0, highMatch: 0,
        canonicalAdded: 0, canonicalUpdated: 0,
        employers: new Set(), runtimeMs: 0, cacheHits: 0, cacheMisses: 0,
      });
    }
    return providerStats.get(id);
  };

  const allRaw = [];
  const errors = [];
  const runGroup = async (group) => {
    const stat = statFor(group[0].provider.id);
    for (const ex of group) {
      if (opts.cancelCheck?.()) throw discoveryError('CANCELLED', 'cancel requested');
      stat.requested++;
      const scope = cacheScope(ex.provider.id, { query: ex.query, location });
      const tStart = Date.now();
      try {
        if (!opts.refresh && dataRoot) {
          const cached = loadCache(dataRoot, scope);
          if (cached && isFresh(cached, CACHE_TTL_MS) && Array.isArray(cached.jobsSnapshot)) {
            stat.succeeded++;
            stat.cacheHits++;
            stat.raw += cached.jobsSnapshot.length;
            stat.runtimeMs += Date.now() - tStart;
            statQuery(ex.provider.id, ex.query).retrieved += cached.jobsSnapshot.length;
            for (const job of cached.jobsSnapshot) {
              allRaw.push({ ...job, _providerId: ex.provider.id, _query: ex.query, _queryFamily: ex.family, _cached: true });
              traceMark(job?.url, 'retrieved', { query: ex.query, provider: ex.provider.id });
            }
            continue;
          }
        }
        const res = await runProvider(ex.provider, ex.entry, ctx);
        stat.runtimeMs += Date.now() - tStart;
        stat.cacheMisses++;
        if (res.status === 'error') {
          stat.failed++;
          stat.errorTypes[res.errorType] = (stat.errorTypes[res.errorType] || 0) + 1;
          stat.lastErrorType = res.errorType;
          errors.push({ provider: ex.provider.id, query: ex.query, errorType: res.errorType, message: res.message });
          if (dataRoot && !opts.dryRun) recordFailure(dataRoot, scope, { errorType: res.errorType, message: res.message });
          continue;
        }
        stat.succeeded++;
        stat.raw += res.jobs.length;
        statQuery(ex.provider.id, ex.query).retrieved += res.jobs.length;
        if (dataRoot && !opts.dryRun) {
          recordSuccess(dataRoot, scope, { jobIds: res.jobs.map((j) => String(j?.url || '')).filter(Boolean), jobCount: res.jobs.length, jobsSnapshot: res.jobs });
        }
        for (const job of res.jobs) {
          allRaw.push({ ...job, _providerId: ex.provider.id, _query: ex.query, _queryFamily: ex.family });
          traceMark(job?.url, 'retrieved', { query: ex.query, provider: ex.provider.id });
        }
      } catch (err) {
        stat.runtimeMs += Date.now() - tStart;
        stat.failed++;
        stat.errorTypes.FETCH_ERROR = (stat.errorTypes.FETCH_ERROR || 0) + 1;
        stat.lastErrorType = 'FETCH_ERROR';
        errors.push({ provider: ex.provider.id, query: ex.query, errorType: 'FETCH_ERROR', message: err?.message || String(err) });
      }
    }
  };
  await poolAll([...byProvider.values()], PROVIDER_CONCURRENCY, runGroup);
  t.providers = Date.now() - tp;
  reportStage('SEARCHING', { providers: [...providerStats.keys()] });

  // ---- normalize + US-only + freshness ----
  const tn = Date.now();
  const cutoff = now - maxAgeDays * 86_400_000;
  const accepted = [];
  const funnel = { raw: allRaw.length, us: 0, fresh: 0 };
  for (const raw of allRaw) {
    const stat = statFor(raw._providerId);
    let job;
    try {
      job = normalizeProviderJob(providerModules.get(raw._providerId), raw, raw._providerId, now);
    } catch {
      traceMark(raw?.url, 'loss', { reason: 'unnormalizable (missing title/url)' });
      continue;
    }
    stat.normalized++;
    statQuery(raw._providerId, raw._query).normalized++;
    traceMark(raw?.url, 'normalized', { query: raw._query, provider: raw._providerId });
    const usVerdict = classifyUsLocation(job.location, { url: job.url });
    if (usVerdict.verdict !== 'us') {
      traceMark(raw?.url, 'loss', { reason: `non-US location: ${(usVerdict.evidence || []).join('; ')}` });
      continue;
    }
    stat.us++;
    funnel.us++;
    traceMark(raw?.url, 'us', { query: raw._query, provider: raw._providerId });
    if (typeof job.postedAt === 'number' && Number.isFinite(job.postedAt) && job.postedAt < cutoff) {
      traceMark(raw?.url, 'loss', { reason: `stale: posted ${new Date(job.postedAt).toISOString().slice(0, 10)} before ${maxAgeDays}d cutoff` });
      continue;
    }
    stat.fresh++;
    funnel.fresh++;
    traceMark(raw?.url, 'fresh', { query: raw._query, provider: raw._providerId });
    accepted.push({ ...job, _providerId: raw._providerId, _query: raw._query, _queryFamily: raw._queryFamily || null });
  }
  t.normalize = Date.now() - tn;

  // ---- canonical dedup (per-run) + job-store upsert ----
  const td = Date.now();
  const canonicalStore = new Map();
  const unique = [];
  const seenProviders = new Map(); // canonicalKey → Set(providerId)
  // Attribution index (§13–14): canonicalKey AND normalized URL → providers
  // and queries that observed the job this run. URL forms cover records the
  // store merges under a pre-existing (older-title) key.
  const attrByKey = new Map();
  const attr = (key, provider, query) => {
    if (!key) return;
    let e = attrByKey.get(key);
    if (!e) { e = { providers: new Set(), queries: new Map() }; attrByKey.set(key, e); }
    e.providers.add(provider);
    if (query) {
      if (!e.queries.has(provider)) e.queries.set(provider, new Set());
      e.queries.get(provider).add(query);
    }
  };
  const attrJob = (job) => {
    attr(canonicalJobKey(job), job._providerId, job._query);
    try {
      const nu = normalizeJobUrl(job.url);
      if (nu) attr(`url:${nu}`, job._providerId, job._query);
    } catch { /* canonical key suffices */ }
  };
  // Per-key query accumulation (§14): every accepted sighting (including
  // per-run dupes) contributes its (provider, query); the surviving unique
  // job carries the full set into the store merge.
  const keyQueries = new Map(); // key → Map(provider → Map(query → family))
  const noteQuery = (key, provider, query, family = null) => {
    if (!key || !query) return;
    if (!keyQueries.has(key)) keyQueries.set(key, new Map());
    const m = keyQueries.get(key);
    if (!m.has(provider)) m.set(provider, new Map());
    if (!m.get(provider).has(query)) m.get(provider).set(query, family || null);
  };
  const queriesFor = (key) => {
    const out = [];
    for (const [provider, qs] of keyQueries.get(key) || []) {
      for (const [query, family] of qs) out.push({ provider, query, family });
    }
    return out;
  };
  for (const job of accepted) {
    const key = canonicalJobKey(job) || `url:${job.url}`;
    const { opportunity, isNew } = mergeIntoCanonical(canonicalStore, { ...job, source: job._providerId });
    attrJob(job);
    noteQuery(key, job._providerId, job._query, job._queryFamily || null);
    const stat = statFor(job._providerId);
    if (!isNew) {
      stat.dupes++;
      traceMark(job?.url, 'loss', { reason: `duplicate of canonical ${opportunity.key}` });
      const set = seenProviders.get(opportunity.key) || new Set();
      set.add(job._providerId);
      seenProviders.set(opportunity.key, set);
      continue;
    }
    traceMark(job?.url, 'canonical', { canonicalKey: opportunity.key });
    seenProviders.set(opportunity.key, new Set([job._providerId]));
    unique.push({ ...job, sources: [job._providerId], _queries: queriesFor(key) });
  }
  // Refresh survivors with the FULL per-key query set (later dupes noted
  // theirs after the survivor was pushed).
  for (const u of unique) {
    const k = canonicalJobKey(u) || `url:${u.url}`;
    u._queries = queriesFor(k);
  }
  // Attribute accepted + employers to first-seen providers.
  for (const job of unique) {
    const stat = statFor(job._providerId);
    stat.accepted++;
    statQuery(job._providerId, job._query).accepted++;
    const emp = normalizeCompanyIdentity(job.company);
    if (emp) stat.employers.add(emp);
  }
  funnel.unique = unique.length;
  funnel.dupes = accepted.length - unique.length;
  t.dedup = Date.now() - td;

  const tpe = Date.now();
  const jobStorePath = opts.jobStorePath || (dataRoot ? join(dataRoot, 'data', 'scavenger', 'job-store.json') : null);
  // Canonical ids observed this run (snapshot for consecutive-run diffs §8–9).
  const observedJobIds = unique.map((u) => canonicalJobKey(u) || '').filter(Boolean);
  // A FAILED run (zero successful provider observations, cache included)
  // modifies no persisted liveness state at all (§16). Successful runs —
  // even with zero accepted jobs — persist normally.
  const anyProviderSuccess = [...providerStats.values()].some((s) => s.succeeded > 0);
  let persisted = { added: 0, updated: 0, unchanged: 0, changes: [] };
  const livenessApplied = [];
  if (jobStorePath && !opts.dryRun && anyProviderSuccess) {
    const jobs = openJobRepository(jobStorePath);
    const store = jobs.load();
    // Meaningful diffs against the pre-upsert records (for the feed).
    const preChanges = [];
    for (const u of unique) {
      const prev = store.jobs[canonicalJobKey(u) || ''];
      if (prev) {
        const d = diffJobs(prev, u, now);
        if (d.state === 'CHANGED') preChanges.push({ jobId: d.jobId, changedFields: d.changedFields });
      }
    }
    persisted = upsertJobs(store, unique, now);
    persisted.changes = preChanges;
    persisted.lifecycle = refreshLifecycle(store, { now });
    // Attribute canonical added/updated per provider (§13) via the
    // attribution index (canonical key + normalized URL forms cover
    // URL-merged records whose stored key predates this run).
    for (const [storedId, outcome] of Object.entries(persisted.byId || {})) {
      if (outcome !== 'added' && outcome !== 'updated') continue;
      const rec = store.jobs[storedId];
      const candidates = [
        attrByKey.get(storedId),
        ...(rec ? [rec.url, ...(rec.urls || [])].map((u) => {
          try { return attrByKey.get(`url:${normalizeJobUrl(u)}`); } catch { return null; }
        }) : []),
      ].filter(Boolean);
      const seen = new Set();
      for (const attrE of candidates) {
        for (const p of attrE.providers) {
          if (seen.has(p) || !providerStats.has(p)) continue;
          seen.add(p);
          const stat = providerStats.get(p);
          if (outcome === 'added') stat.canonicalAdded++;
          else stat.canonicalUpdated++;
        }
      }
    }
    // Explicit closure evidence (§6): validated, reason-trailed, applied to
    // the canonical record without touching history or outcomes.
    for (const [ref, evidence] of Object.entries(opts.closedEvidence || {})) {
      const check = assertClosedEvidence(evidence);
      if (!check.ok) {
        errors.push({ provider: 'liveness', query: String(ref), errorType: 'INVALID_EVIDENCE', message: check.reason });
        continue;
      }
      const id = store.jobs[ref]
        ? ref
        : Object.entries(store.jobs).find(([, r]) => {
            const urls = [r?.url, ...((r && r.urls) || [])].map((u) => normalizeJobUrl(u)).filter(Boolean);
            return urls.includes(normalizeJobUrl(ref));
          })?.[0] || null;
      if (!id) {
        errors.push({ provider: 'liveness', query: String(ref), errorType: 'UNKNOWN_JOB', message: 'no canonical record matches ref' });
        continue;
      }
      const applied = applyLiveness(store, id, { state: 'OBSERVED_CLOSED', reason: evidence.reason, evidence }, now);
      if (applied.applied) livenessApplied.push({ jobId: id, evidence });
    }
    jobs.save(store);
  } else if (opts.dryRun) {
    const store = emptyStore();
    persisted = upsertJobs(store, unique, now);
  }
  t.persist = Date.now() - tpe;
  reportStage('NORMALIZING', { funnel: { ...funnel } });

  // ---- employer resolution (tiers unchanged, enrichment offline) ----
  const boardJobs = unique.map((j) => ({ ...j, _discoverySource: j._providerId }));
  const triage = aggregateDiscovery(boardJobs);
  const jobsByKey = new Map();
  for (const job of boardJobs) {
    const key = normalizeCompanyIdentity(String(job.company || ''));
    if (!key) continue;
    if (!jobsByKey.has(key)) jobsByKey.set(key, []);
    jobsByKey.get(key).push(job);
  }
  const discovery = { high: [], medium: [], low: [], existing: triage.existing };
  for (const d of triage.decisions) {
    const enriched = d.tier === 'medium' ? enrichDecision(d, jobsByKey.get(d.key) || []) : d;
    if (enriched.tier === 'high') discovery.high.push(enriched);
    else if (enriched.tier === 'medium') discovery.medium.push(enriched);
    else discovery.low.push({ key: enriched.key, name: enriched.name, rejectReason: enriched.rejectReason });
  }
  // ---- match selected profiles ----
  const tm = Date.now();
  const pool = matchPool(unique, profiles.map((p) => ({ id: p.id, profile: p.profile })));
  // Remap match ids to canonical keys (§8: matches reference the ONE shared
  // record). matchJob ids are source-scoped; the canonical key is what the
  // job-store, history, and saved refs all use.
  const canonicalByMatchId = new Map();
  for (const u of unique) {
    const matchId = normalizeJob(u, u.source || 'unknown', now).id;
    canonicalByMatchId.set(matchId, canonicalJobKey(u) || matchId);
  }
  for (const agg of pool) {
    const canonical = canonicalByMatchId.get(agg.jobId);
    if (canonical) {
      agg.jobId = canonical;
      for (const m of agg.matches || []) m.jobId = canonical;
    }
  }
  // Trace marking for matched stage: traced URLs resolve through the unique
  // records they survived in (canonical keys), then into pool aggregates.
  if (traceWanted.size) {
    const urlToCanonical = new Map();
    for (const u of unique) {
      const canon = canonicalJobKey(u) || '';
      for (const raw of [u.url, ...(u.urls || [])]) {
        const k = traceKeyOf(raw);
        if (k && traceWanted.has(k) && canon) urlToCanonical.set(k, canon);
      }
    }
    const aggByCanonical = new Map(pool.map((a) => [a.jobId, a]));
    for (const [key, t] of traces) {
      const canon = urlToCanonical.get(key);
      const agg = canon ? aggByCanonical.get(canon) : null;
      if (agg) traceMark(key, 'matched', { score: agg.best?.score ?? null, band: typeof agg.best?.band === 'string' ? agg.best.band : agg.best?.band?.label || null });
      else if (t.canonical) traceMark(key, 'loss', { reason: 'canonical record unmatched (below score floor or no profile overlap)' });
    }
  }
  // Attribute high matches per provider via best-match origin.
  for (const agg of pool) {
    if (agg.best && agg.best.score >= 75) {
      const origin = unique.find((u) => u.url && agg.jobId.includes(u.url));
      if (origin && providerStats.has(origin._providerId)) providerStats.get(origin._providerId).highMatch++;
    }
  }
  t.matching = Date.now() - tm;
  reportStage('MATCHING', { matched: pool.length });

  const completedAt = new Date().toISOString();
  const providerResults = [...providerStats.values()].map((s) => ({
    id: s.id,
    status: discoveryProviderStatus(s),
    requested: s.requested, succeeded: s.succeeded, failed: s.failed,
    errorTypes: s.errorTypes, lastErrorType: s.lastErrorType,
    raw: s.raw, normalized: s.normalized || 0, us: s.us, fresh: s.fresh, accepted: s.accepted, dupes: s.dupes,
    highMatch: s.highMatch, canonicalAdded: s.canonicalAdded || 0, canonicalUpdated: s.canonicalUpdated || 0,
    uniqueEmployers: s.employers.size, runtimeMs: Math.round(s.runtimeMs),
    cacheHits: s.cacheHits, cacheMisses: s.cacheMisses,
  }));
  const anySuccess = providerResults.some((p) => p.succeeded > 0);
  const anyFailure = providerResults.some((p) => p.failed > 0);
  const status = !anySuccess ? 'FAILED' : anyFailure ? 'PARTIAL' : 'COMPLETE';
  // Missing-job computation (§8): previous COMPLETE run's observed ids minus
  // this run's — only when THIS run is also COMPLETE. PARTIAL/FAILED absence
  // proves nothing, so missingJobIds stays empty for them. Missing never
  // closes anything; it only informs staleness review.
  const runsPath = opts.runsPath || (dataRoot ? join(dataRoot, 'data', 'scavenger', 'discovery-runs.json') : null);
  let missingJobIds = [];
  if (safeForClosure(status) && runsPath && !opts.dryRun) {
    const prevComplete = openDiscoveryRunRepository(runsPath).latest('COMPLETE');
    if (prevComplete && Array.isArray(prevComplete.observedJobIds)) {
      const curr = new Set(observedJobIds);
      missingJobIds = prevComplete.observedJobIds.filter((id) => !curr.has(id));
    }
  }
  const matchesByProfile = {};
  for (const p of profiles) {
    const scored = pool.map((agg) => (agg.matches || []).find((m) => m.profileId === p.id)).filter(Boolean);
    matchesByProfile[p.id] = {
      matched: scored.length,
      highMatch: scored.filter((m) => m.score >= 75).length,
      avgScore: scored.length ? Math.round(scored.reduce((a, m) => a + m.score, 0) / scored.length) : null,
    };
  }
  // Per-(provider, query, family) retrieval trace (§12–14): descriptive only,
  // never an optimization input.
  const queryStatsList = [...queryStats.values()];
  // Finalize opt-in URL traces with first-loss classification (§6, Phase 12).
  const traceList = [...traces.values()].map((t) => {
    let status = 'MATCHED_LOW';
    if (!t.retrieved) status = 'NOT_RETRIEVED';
    else if (!t.normalized) status = 'FILTERED_TITLE';
    else if (!t.usAccepted) status = 'FILTERED_LOCATION';
    else if (!t.fresh) status = 'FILTERED_FRESHNESS';
    else if (!t.canonical) status = 'DUPLICATED';
    else if (typeof t.matchedBest === 'number' && t.matchedBest >= 75) status = 'MATCHED_HIGH';
    return { ...t, status };
  });

  const result = {
    runId, startedAt, completedAt, status,
    durationMs: Date.now() - t0,
    profiles: profiles.map((p) => p.id),
    queries,
    queryStats: queryStatsList,
    traces: traceList,
    providers: providerResults,    jobsDiscovered: funnel.raw,
    jobsAccepted: unique.length,
    jobsDeduplicated: funnel.dupes,
    jobsPersisted: persisted,
    changes: persisted.changes || [],
    observedJobIds,
    missingJobIds,
    livenessApplied,
    funnel: { raw: funnel.raw, us: funnel.us, fresh: funnel.fresh, unique: funnel.unique },
    matchesByProfile,
    discovery: {
      high: discovery.high.length, medium: discovery.medium.length,
      low: discovery.low.length, existing: discovery.existing,
      newEmployers: discovery.high.map((d) => ({ name: d.name, confidence: d.confidence, sources: d.sources })),
      reviewQueue: discovery.medium.map((d) => ({ name: d.name, confidence: d.confidence, evidence: d.evidence, sources: d.sources })),
    },
    matches: pool,
    providerHealth: Object.fromEntries(providerResults.map((p) => [p.id, p.status])),
    errors,
    timings: {
      planningMs: t.planning, providerMs: t.providers, normalizeMs: t.normalize,
      dedupMs: t.dedup, persistMs: t.persist, matchingMs: t.matching,
      totalMs: Date.now() - t0,
    },
  };

  // ---- run history (durable, capped, atomic) ----
  if (runsPath && !opts.dryRun) {
    const runs = readRuns(runsPath);
    const cache = { hits: 0, misses: 0 };
    for (const p of providerResults) { cache.hits += p.cacheHits; cache.misses += p.cacheMisses; }
    runs.push({
      runId, createdAt: startedAt, completedAt, durationMs: result.durationMs, status,
      userId: opts.userId || 'local',
      selectedProfileIds: profiles.map((p) => p.id),
      queries,
      queryStats: queryStatsList,
      providersRequested: wanted,
      providersExecuted: providerResults.map((p) => p.id),
      providerHealth: Object.fromEntries(providerResults.map((p) => [p.id, p.status])),
      rawCounts: Object.fromEntries(providerResults.map((p) => [p.id, p.raw])),
      normalizedCounts: Object.fromEntries(providerResults.map((p) => [p.id, p.normalized || 0])),
      usAcceptedCounts: Object.fromEntries(providerResults.map((p) => [p.id, p.accepted])),
      freshCounts: Object.fromEntries(providerResults.map((p) => [p.id, p.fresh])),
      duplicateCounts: Object.fromEntries(providerResults.map((p) => [p.id, p.dupes])),
      canonicalAddedByProvider: Object.fromEntries(providerResults.map((p) => [p.id, p.canonicalAdded || 0])),
      canonicalUpdatedByProvider: Object.fromEntries(providerResults.map((p) => [p.id, p.canonicalUpdated || 0])),
      canonicalAdded: persisted.added, canonicalUpdated: persisted.updated,
      unchangedJobs: persisted.unchanged,
      changedJobIds: (persisted.changes || []).map((c) => c.jobId),
      observedJobIds,
      missingJobIds,
      matchesByProfile,
      errors: errors.map((e) => ({ provider: e.provider, errorType: e.errorType })),
      cache,
    });
    writeRuns(runsPath, runs);
  }

  return result;
}

/** Read recent discovery runs (for "what changed since last search" UX). */
export function readDiscoveryRuns(runsPath) {
  return readRuns(runsPath);
}
