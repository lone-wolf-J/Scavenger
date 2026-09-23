// Liveness verification service — "re-check the jobs we already know".
//
// Operates INDEPENDENTLY from discovery (Phase 9 §6): discovery answers what
// can be found; this answers whether known jobs are still there. One bounded
// pass: select candidates → verify each hook-capable source → record results
// → evaluate lifecycle → persist atomically → return structured results.
//
// Verification is source-specific (§8): a job observed on Dice + LinkedIn is
// verified per source, and one source's result is never treated as proof
// about another. Canonical lifecycle changes only through the existing
// liveness rules (explicit CLOSED evidence, or repeated NOT_FOUND when the
// provider declares reliable absence AND policy allows it). Provider failure
// NEVER closes anything.
//
// Verification runs once per JOB, never once per profile (§proof-8):
// candidates are canonical records; profile history only informs priority.

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  defaultLivenessPolicy,
  validatePolicy,
  verifyJobs,
  getVerificationCandidates,
  recordVerification,
  evaluateAbsence,
  consecutiveNotFoundStreak,
  isFailureStatus,
} from './liveness-engine.mjs';
import { loadStore, saveStore } from './job-store.mjs';
import { loadProviders } from '../providers/_registry.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROVIDERS_DIR = join(HERE, '..', 'providers');

/** Providers on a record that expose a verifyJob hook. */
export function verifiableSources(record, providerModules) {
  const sources = Array.isArray(record?.sources) && record.sources.length
    ? record.sources
    : (record?.source ? [record.source] : []);
  return [...new Set(sources)].filter((s) => typeof providerModules?.get?.(s)?.verifyJob === 'function');
}

/**
 * Bounded verification pass over known jobs.
 *
 * @param {object} opts
 * @param {string} [opts.storePath] canonical job-store path (required unless store given)
 * @param {object} [opts.store] pre-loaded store object (skips file load)
 * @param {object} [opts.histories] match-history {matches} for candidate priority (default: none → all ROUTINE)
 * @param {Map} [opts.providerModules] pre-loaded provider modules (default: loadProviders)
 * @param {string} [opts.providersDir]
 * @param {object} [opts.ctx] provider fetch context (default: makeHttpCtx())
 * @param {object} [opts.policy] liveness policy overrides
 * @param {number} [opts.limit] max JOBS to verify (default 25)
 * @param {string} [opts.provider] restrict to one provider id
 * @param {string} [opts.jobId] verify exactly one canonical job
 * @param {boolean} [opts.dryRun] select + verify, persist nothing
 * @param {number} [opts.now]
 * @returns {Promise<{selected, results, summary, persisted, dryRun}>}
 */
export async function verifyExistingJobs(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const policy = validatePolicy(opts.policy || {});
  const limit = opts.jobId ? 1 : Math.max(1, Math.min(1000, Number.isInteger(opts.limit) ? opts.limit : 25));
  const dryRun = opts.dryRun === true;
  const storePath = opts.storePath || null;
  const store = opts.store || (storePath ? loadStore(storePath) : { version: 1, jobs: {} });
  const histories = opts.histories || {};
  const providerModules = opts.providerModules || await loadProviders(opts.providersDir || DEFAULT_PROVIDERS_DIR);
  const ctx = opts.ctx || { ...makeHttpCtx() };

  let pool = Object.values(store.jobs || {}).filter((j) => j && j.jobId);
  if (opts.jobId) pool = pool.filter((j) => j.jobId === opts.jobId);
  if (opts.provider) pool = pool.filter((j) => verifiableSources(j, providerModules).includes(opts.provider));

  const selected = getVerificationCandidates({ jobs: pool, histories, limit, policy, now });
  const byId = new Map(pool.map((j) => [j.jobId, j]));

  // One task per (job, verifiable source): bounded by the job limit, with
  // per-job fan-out over hook-capable sources only.
  const tasks = [];
  for (const c of selected) {
    const record = byId.get(c.jobId);
    if (!record) continue;
    let sources = verifiableSources(record, providerModules);
    if (opts.provider) sources = sources.filter((s) => s === opts.provider);
    for (const source of sources) tasks.push({ job: record, source, candidate: c });
  }

  const raw = await verifyJobs({
    jobs: tasks.map((t) => t.job),
    sourceOf: (_, i) => tasks[i].source,
    providerModules,
    ctx,
    policy,
    now,
  });

  const results = [];
  const summary = {
    selected: selected.length,
    verified: 0,
    skipped: 0,
    active: 0,
    closed: 0,
    notFound: 0,
    unknown: 0,
    failed: 0,
    persisted: 0,
  };
  // Candidates with no hook-capable source are reported, never verified:
  // an UNKNOWN observation would be noise, and guessing is forbidden.
  for (const c of selected) {
    const record = byId.get(c.jobId);
    if (!record) continue;
    let sources = verifiableSources(record, providerModules);
    if (opts.provider) sources = sources.filter((s) => s === opts.provider);
    if (!sources.length) {
      summary.skipped++;
      results.push({
        jobId: c.jobId,
        provider: null,
        status: 'SKIPPED',
        evidenceType: null,
        checkedAt: new Date(now).toISOString(),
        runtimeMs: null,
        priority: c.priority,
        reason: c.reason,
        lifecycle: record.lifecycle || 'active',
        closed: false,
        persisted: false,
        via: 'no-verifiable-source',
      });
    }
  }
  for (let i = 0; i < tasks.length; i++) {
    const { job, source, candidate } = tasks[i];
    const r = raw[i];
    const status = r.status;
    summary.verified++;
    if (status === 'ACTIVE') summary.active++;
    else if (status === 'CLOSED') summary.closed++;
    else if (status === 'NOT_FOUND') summary.notFound++;
    else if (status === 'UNKNOWN') summary.unknown++;
    if (isFailureStatus(status) && status !== 'UNKNOWN') summary.failed++;

    let outcome = { applied: false, closed: false, skipped: true };
    if (!dryRun) {
      if (status === 'NOT_FOUND') {
        // Observation, not verdict: close only via the absence policy.
        const streak = consecutiveNotFoundStreak(job, source) + 1;
        const decision = evaluateAbsence({
          jobId: job.jobId,
          provider: providerModules.get(source),
          consecutiveNotFounds: streak,
          policy,
        });
        if (decision.close) {
          outcome = {
            ...recordVerification(store, job.jobId, { provider: source, status: 'CLOSED', evidence: decision.evidence, checkedAt: r.checkedAt }, { policy, now }),
            via: 'repeated-absence',
            streak,
          };
        } else {
          outcome = {
            ...recordVerification(store, job.jobId, { provider: source, status, evidence: r.evidence, checkedAt: r.checkedAt, runtimeMs: r.runtimeMs }, { policy, now }),
            via: 'observation',
            streak,
            absenceReason: decision.reason,
          };
        }
      } else {
        outcome = {
          ...recordVerification(store, job.jobId, { provider: source, status, evidence: r.evidence, checkedAt: r.checkedAt, runtimeMs: r.runtimeMs }, { policy, now }),
          via: status === 'CLOSED' ? 'explicit-evidence' : 'observation',
        };
      }
      if (outcome.applied) summary.persisted++;
    }
    results.push({
      jobId: job.jobId,
      provider: source,
      status,
      evidenceType: r.evidence?.type || null,
      checkedAt: r.checkedAt,
      runtimeMs: r.runtimeMs,
      priority: candidate.priority,
      reason: candidate.reason,
      lifecycle: job.lifecycle || 'active',
      closed: dryRun ? false : !!outcome.closed,
      persisted: dryRun ? false : !!outcome.applied,
      ...(outcome.via ? { via: outcome.via } : {}),
    });
  }

  let persisted = false;
  if (!dryRun && storePath) {
    saveStore(store, storePath); // atomic tmp+rename; malformed input never merged (loadStore)
    persisted = true;
  }
  return { selected, results, summary, persisted, dryRun };
}
