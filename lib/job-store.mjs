// Shared job intelligence store — one canonical record per job, ever.
//
// USER data (profiles, matches) lives separately from SHARED data (jobs,
// companies). A new profile matches against the store; it never duplicates
// job records per user. File-backed via injected paths (libs stay CLI- and
// web-agnostic: pass state objects and paths in, get data out).
//
// Store shape: { version: 1, jobs: { [jobId]: CanonicalJob } }
// CanonicalJob: { jobId, canonicalKey, title, company, location, url,
//   applyUrl, source, sourceJobId, sources[], postedAt, discoveredAt,
//   firstSeen, lastSeen, seenCount, salary?, description?,
//   descriptionHash, lifecycle: 'active'|'stale'|'closed', lifecycleAt,
//   lastChangedAt, lastChangedFields[], closedEvidence?,
//   sourceQueries: { [provider]: string[] },
//   sourceQueryFamilies: { [provider]: { [query]: family } },
//   verificationHistory: [{ provider, status, checkedAt, runtimeMs, evidence? }],
//   verificationBySource: { [provider]: { status, checkedAt, evidenceType? } },
//   lastVerifiedAt? }

import { existsSync } from 'fs';
import { atomicWriteJson, readJsonStrict } from './atomic-write.mjs';
import { canonicalJobKey, normalizeJobUrl } from './job-dedup.mjs';
import { diffJobs, descriptionHash } from './job-diff.mjs';

export function jobIdFor(job) {
  const key = canonicalJobKey(job);
  if (key) return key;
  const url = normalizeJobUrl(job?.url);
  if (url) return `url:${url}`;
  return '';
}

export function emptyStore() {
  return { version: 1, jobs: {} };
}

export function loadStore(storePath) {
  if (!storePath || !existsSync(storePath)) return emptyStore();
  const parsed = readJsonStrict(storePath); // malformed → empty, never merged
  if (parsed && parsed.jobs && typeof parsed.jobs === 'object' && !Array.isArray(parsed.jobs)) {
    // Backward compatibility: pre-lifecycle records gain defaults in place.
    for (const record of Object.values(parsed.jobs)) {
      if (record && typeof record === 'object') {
        if (!record.lifecycle) { record.lifecycle = 'active'; record.lifecycleAt = null; }
        if (!record.descriptionHash) {
          record.descriptionHash = descriptionHash(typeof record.description === 'string' ? record.description : '');
        }
        if (!Array.isArray(record.sources)) record.sources = record.source ? [record.source] : [];
      }
    }
    return { version: 1, jobs: parsed.jobs };
  }
  return emptyStore();
}

export function saveStore(store, storePath) {
  atomicWriteJson(storePath, store);
}

/**
 * Upsert normalized jobs. Lookup order per job:
 *   1. canonical key (title/company/location/date identity), then
 *   2. normalized posting URL against record url/urls.
 * A title/company/location change to the SAME posting URL merges into the
 * existing record (key stays stable, so saved refs and history keys never
 * break) and surfaces as a meaningful diff. Same URL ≈ same posting.
 * @returns {{added: number, updated: number, unchanged: number,
 *   changes: Array<{jobId, changedFields: string[]}>,
 *   byId: Record<string, 'added'|'updated'|'unchanged'>}}
 * changes[] carries MEANINGFUL diffs only (job-diff.mjs); volatile metadata
 * movement (lastSeen/seenCount/sources) never appears here.
 * `job._query` (transient, never persisted) merges into the record's
 * `sourceQueries: { [provider]: string[] }` (bounded 10/provider) so a
 * canonical job retains which queries surfaced it on which board.
 */
export function upsertJobs(store, jobs, now = Date.now()) {
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const changes = [];
  const byId = {};
  // URL index over existing records (rebuilt per call; stores are small).
  const urlIndex = new Map();
  for (const [id, record] of Object.entries(store.jobs || {})) {
    if (!record || typeof record !== 'object') continue;
    for (const u of [record.url, ...(record.urls || [])]) {
      const norm = normalizeJobUrl(u);
      if (norm && !urlIndex.has(norm)) urlIndex.set(norm, id);
    }
  }
  const indexUrls = (id, record) => {
    for (const u of [record.url, ...(record.urls || [])]) {
      const norm = normalizeJobUrl(u);
      if (norm && !urlIndex.has(norm)) urlIndex.set(norm, id);
    }
  };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') continue;
    const url = normalizeJobUrl(job.url);
    const id = jobIdFor(job);
    let key = null;
    if (id && store.jobs[id]) key = id;
    else if (url && urlIndex.has(url)) key = urlIndex.get(url);
    if (!key && !id) { unchanged++; continue; }
    if (!key) key = id;
    const prev = store.jobs[key];
    const src = job.source || 'unknown';
    if (!prev) {
      store.jobs[key] = {
        jobId: key,
        canonicalKey: key,
        title: job.title || '',
        company: job.company || '',
        location: job.location || '',
        workplaceType: job.workplaceType || '',
        employmentType: job.employmentType || '',
        url: job.url || '',
        applyUrl: job.applyUrl || job.url || '',
        source: src,
        sourceJobId: job.sourceJobId || '',
        sources: [src],
        postedAt: job.postedAt ?? null,
        discoveredAt: job.discoveredAt ?? now,
        firstSeen: now,
        lastSeen: now,
        seenCount: 1,
        salary: job.salary ?? null,
        description: typeof job.description === 'string' ? job.description.slice(0, 4000) : '',
        descriptionHash: descriptionHash(typeof job.description === 'string' ? job.description : ''),
        lifecycle: 'active',
        lifecycleAt: new Date(now).toISOString(),
        lastChangedAt: null,
        lastChangedFields: [],
        sourceQueries: mergeQueryList(mergeSourceQueries(null, src, job._query), job._queries),
        sourceQueryFamilies: mergeQueryFamilies(null, job._queries),
      };
      indexUrls(key, store.jobs[key]);
      added++;
      byId[key] = 'added';
      continue;
    }
    let touched = false;
    if (!prev.sources.includes(src)) { prev.sources.push(src); touched = true; }
    if (url && prev.url !== job.url && !prev.urls?.includes(url)) {
      prev.urls = [...(prev.urls || []), url].slice(0, 10);
      indexUrls(key, prev);
      touched = true;
    }
    // Meaningful diff BEFORE merging, so the feed can report what changed.
    // (No direct field merges above this point — they would mask the diff.)
    // Descriptions compare on the stored (truncated) basis so re-seeing an
    // identical long description is UNCHANGED, not a false CHANGED.
    const candidate = {
      ...prev,
      title: job.title || prev.title,
      company: job.company || prev.company,
      location: job.location ?? prev.location,
      workplaceType: job.workplaceType ?? prev.workplaceType,
      employmentType: job.employmentType ?? prev.employmentType,
      salary: job.salary ?? prev.salary,
      description: typeof job.description === 'string' ? job.description.slice(0, 4000) : (prev.description || ''),
      url: job.url || prev.url,
      postedAt: typeof job.postedAt === 'number' ? job.postedAt : prev.postedAt,
    };
    const diff = diffJobs(prev, candidate, now);
    if (diff.state === 'CHANGED') {
      prev.lastChangedAt = diff.detectedAt;
      prev.lastChangedFields = diff.changedFields;
      changes.push({ jobId: key, changedFields: diff.changedFields });
    }
    // Merge the fresh values (diff ran against the same candidate).
    prev.title = candidate.title;
    prev.company = candidate.company;
    prev.location = candidate.location;
    prev.workplaceType = candidate.workplaceType;
    prev.employmentType = candidate.employmentType;
    prev.salary = candidate.salary;
    prev.description = typeof candidate.description === 'string' ? candidate.description.slice(0, 4000) : '';
    prev.descriptionHash = descriptionHash(prev.description);
    prev.url = candidate.url;
    if (job.applyUrl) prev.applyUrl = job.applyUrl;
    prev.postedAt = candidate.postedAt;
    // Any observation keeps the record alive; explicit closure evidence stays.
    if (prev.lifecycle !== 'closed' || !prev.closedEvidence) {
      if (prev.lifecycle !== 'active') { prev.lifecycleAt = new Date(now).toISOString(); }
      if (!prev.closedEvidence) prev.lifecycle = 'active';
    }
    prev.lastSeen = now;
    prev.seenCount = (prev.seenCount || 1) + 1;
    prev.sourceQueries = mergeQueryList(mergeSourceQueries(prev.sourceQueries, src, job._query), job._queries);
    prev.sourceQueryFamilies = mergeQueryFamilies(prev.sourceQueryFamilies, job._queries);
    if (touched || diff.state === 'CHANGED') { updated++; byId[key] = 'updated'; }
    else { unchanged++; byId[key] = 'unchanged'; }
  }
  return { added, updated, unchanged, changes, byId };
}

export function getJob(store, jobId) {
  return store?.jobs?.[jobId] || null;
}

/**
 * Merge one observed (provider, query) pair into a record's sourceQueries.
 * Bounded (10 queries/provider), deterministic order, duplicates dropped.
 * Pure helper — exported for tests.
 */
export function mergeSourceQueries(prev, provider, query) {  const out = {};
  if (prev && typeof prev === 'object') {
    for (const [p, qs] of Object.entries(prev)) {
      if (typeof p === 'string' && Array.isArray(qs)) out[p] = qs.filter((q) => typeof q === 'string').slice(0, 10);
    }
  }
  if (typeof provider === 'string' && provider && typeof query === 'string' && query) {
    const list = out[provider] || [];
    if (!list.includes(query)) list.push(query);
    out[provider] = list.slice(0, 10);
  }
  return out;
}

/**
 * Merge a batch of observed (provider, query) pairs (the engine's per-key
 * accumulation across duplicate sightings). Same bounds as the single merge.
 */
export function mergeQueryList(prev, pairs) {
  let out = mergeSourceQueries(prev, null, null);
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    out = mergeSourceQueries(out, pair?.provider, pair?.query);
  }
  return out;
}

/**
 * Merge observed (provider, query, family) triples into the persisted
 * query→family index. Parallel to sourceQueries (which stays a plain
 * string[] map for compatibility); this map answers "which query family
 * surfaced this job on which provider" for search-quality measurement.
 * Bounded the same way (10 queries per provider).
 * @param {object} prev
 * @param {Array<{provider?: string, query?: string, family?: string}>} pairs
 */
export function mergeQueryFamilies(prev, pairs) {
  const out = {};
  if (prev && typeof prev === 'object') {
    for (const [p, m] of Object.entries(prev)) {
      if (typeof p !== 'string' || !m || typeof m !== 'object') continue;
      const kept = {};
      for (const [q, f] of Object.entries(m)) {
        if (typeof q === 'string' && typeof f === 'string') kept[q] = f;
      }
      const qs = Object.keys(kept).slice(0, 10);
      if (qs.length) out[p] = Object.fromEntries(qs.map((q) => [q, kept[q]]));
    }
  }
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const p = pair?.provider;
    const q = pair?.query;
    const f = pair?.family;
    if (typeof p !== 'string' || !p || typeof q !== 'string' || !q || typeof f !== 'string' || !f) continue;
    if (!out[p]) out[p] = {};
    if (!out[p][q]) {
      const qs = Object.keys(out[p]);
      if (qs.length >= 10) continue;
      out[p][q] = f;
    }
  }
  return out;
}

export function allJobs(store) {
  return Object.values(store?.jobs || {});
}
