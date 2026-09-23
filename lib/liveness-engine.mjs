// Liveness verification engine — "do existing opportunities still exist?"
//
// Operates INDEPENDENTLY from discovery requests. Discovery answers what can
// be found; this answers whether known jobs are still there. It reuses
// provider adapters through a normalized contract and never contains
// provider-specific logic.
//
// Verification contract (see providers/_types.js): a provider MAY export
//   verifyJob({ job, ctx }) → Promise<{ status, evidence?, checkedAt? }>
// with status in ACTIVE | CLOSED | NOT_FOUND | BLOCKED | UNSUPPORTED |
// AUTH_REQUIRED | RATE_LIMITED | TEMPORARILY_UNAVAILABLE | ERROR | UNKNOWN.
// Providers without the hook yield UNKNOWN — never guessed.
//
// Failure ⊄ closure (explicit):
//   BLOCKED, UNSUPPORTED, AUTH_REQUIRED, RATE_LIMITED, TEMPORARILY_UNAVAILABLE,
//   ERROR and UNKNOWN can NEVER close a job. Only valid closure evidence
//   (lib/job-liveness.mjs assertClosedEvidence) produces CLOSED.
//   NOT_FOUND is an observation, not a verdict: it requires policy evaluation
//   and closes a job ONLY when the provider contract declares NOT_FOUND a
//   reliable closure signal (provider.verify.reliableAbsence === true) AND
//   the policy allows it (closeOnRepeatedAbsence with absenceThreshold
//   consecutive NOT_FOUNDs). Default: never auto-close on absence.

import { classifyProviderError } from './provider-result.mjs';
import { assertClosedEvidence, makeClosedEvidence, applyLiveness } from './job-liveness.mjs';

export const VERIFY_STATUSES = ['ACTIVE', 'CLOSED', 'NOT_FOUND', 'BLOCKED', 'UNSUPPORTED', 'ERROR', 'UNKNOWN', 'AUTH_REQUIRED', 'RATE_LIMITED', 'TEMPORARILY_UNAVAILABLE'];

// Failure statuses: observable, reportable, never closure evidence.
const FAILURE_STATUSES = new Set(['BLOCKED', 'UNSUPPORTED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'TEMPORARILY_UNAVAILABLE', 'ERROR', 'UNKNOWN']);

/** True when a verify status can never constitute closure evidence. */
export function isFailureStatus(status) {
  return FAILURE_STATUSES.has(status);
}

export function defaultLivenessPolicy() {
  return {
    staleAfterDays: 30,
    closedAfterDays: 120,
    maxAttempts: 3,
    verificationAgeDays: 14,
    absenceThreshold: 3,
    closeOnRepeatedAbsence: false,
    maxHistory: 10,
    concurrency: 4,
  };
}

export function validatePolicy(policy = {}) {
  const p = { ...defaultLivenessPolicy(), ...policy };
  const int = (v, name, min, max) => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`liveness policy: ${name} must be an integer ${min}..${max}`);
    }
  };
  int(p.staleAfterDays, 'staleAfterDays', 1, 3650);
  int(p.closedAfterDays, 'closedAfterDays', 1, 3650);
  int(p.maxAttempts, 'maxAttempts', 1, 10);
  int(p.verificationAgeDays, 'verificationAgeDays', 0, 3650);
  int(p.absenceThreshold, 'absenceThreshold', 1, 100);
  int(p.maxHistory, 'maxHistory', 1, 100);
  int(p.concurrency, 'concurrency', 1, 16);
  if (p.staleAfterDays > p.closedAfterDays) {
    throw new Error('liveness policy: staleAfterDays must not exceed closedAfterDays');
  }
  p.closeOnRepeatedAbsence = p.closeOnRepeatedAbsence === true;
  return p;
}

function classifyVerifyError(err) {
  // A provider may declare its own terminal state (mirrors runProvider).
  if (err && VERIFY_STATUSES.includes(err.providerErrorType)) return err.providerErrorType;
  const { errorType } = classifyProviderError(err);
  if (errorType === 'REQUIRES_AUTH') return 'AUTH_REQUIRED';
  if (errorType === 'RATE_LIMITED') return 'RATE_LIMITED';
  if (errorType === 'BLOCKED' || errorType === 'UNSUPPORTED') return errorType;
  return 'ERROR';
}

/**
 * Verify one canonical job against one provider.
 * @returns {{status, evidence, checkedAt, runtimeMs}}
 */
export async function verifyJob({ job, source, providerModules, ctx = {}, policy = null, now = Date.now() }) {
  const t0 = Date.now();
  const checkedAt = new Date(now).toISOString();
  const done = (status, evidence) => ({ status, evidence, checkedAt, runtimeMs: Date.now() - t0 });
  const provider = providerModules?.get?.(source);
  if (!provider) {
    return done('UNKNOWN', { reason: `unknown provider "${source}" — cannot verify` });
  }
  if (typeof provider.verifyJob !== 'function') {
    return done('UNKNOWN', { reason: `provider "${source}" exposes no verifyJob hook` });
  }
  let attempt = 0;
  const maxAttempts = (policy || defaultLivenessPolicy()).maxAttempts;
  for (;;) {
    attempt++;
    try {
      const res = await provider.verifyJob({ job, ctx });
      const status = String(res?.status || 'UNKNOWN').toUpperCase();
      if (!VERIFY_STATUSES.includes(status)) {
        return done('UNKNOWN', { reason: `provider returned unknown status "${res?.status}"` });
      }
      return done(status, res?.evidence ?? { reason: 'provider-reported' });
    } catch (err) {
      const mapped = classifyVerifyError(err);
      const retryable = mapped === 'RATE_LIMITED' || (mapped === 'ERROR' && attempt < maxAttempts);
      if (!retryable || attempt >= maxAttempts) {
        return done(mapped, { reason: String(err?.message || err || 'verify fetch failed') });
      }
      if (typeof ctx.sleep === 'function') await ctx.sleep(500 * attempt);
      else await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/**
 * Batch verification with bounded concurrency. Pure orchestration — no store
 * writes here; callers persist via recordVerification().
 */
export async function verifyJobs({ jobs, sourceOf, providerModules, ctx, policy, now = Date.now(), onResult = null }) {
  const p = policy || defaultLivenessPolicy();
  const limit = Math.max(1, Math.min(16, p.concurrency));
  const out = new Array(jobs.length);
  let next = 0;
  const workers = new Array(Math.min(limit, Math.max(1, jobs.length))).fill(0).map(async () => {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      const source = typeof sourceOf === 'function' ? sourceOf(job, i) : job?.source;
      out[i] = { jobId: job?.jobId || null, ...(await verifyJob({ job, source, providerModules, ctx, policy: p, now })) };
      if (typeof onResult === 'function') await onResult(out[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Deterministic verification candidate selection (§6, §17).
 * Priority (first match wins), then score desc, then jobId asc:
 *   1. SAVED / APPLIED+ outcomes — the user acted on these
 *   2. HIGH_SCORE (best known score ≥ 85)
 *   3. CHANGED (meaningful diff recorded)
 *   4. APPROACHING_STALE (lastSeen within verificationAgeDays of the stale line)
 *   5. everything else, oldest lastSeen first
 * Every candidate carries its reason — never hidden.
 */
export function getVerificationCandidates({ jobs, histories, limit = 25, policy = null, now = Date.now() } = {}) {
  const p = policy || defaultLivenessPolicy();
  const entries = histories && typeof histories === 'object' ? histories.matches || {} : histories || {};
  const byJob = new Map();
  for (const e of Object.values(entries)) {
    if (!e || typeof e !== 'object' || !e.jobId) continue;
    if (!byJob.has(e.jobId)) byJob.set(e.jobId, []);
    byJob.get(e.jobId).push(e);
  }
  const staleLine = now - p.staleAfterDays * 86_400_000;
  const approachLine = staleLine + p.verificationAgeDays * 86_400_000;
  const scored = [];
  for (const job of jobs || []) {
    if (!job || !job.jobId) continue;
    const matches = byJob.get(job.jobId) || [];
    const best = matches.reduce((m, e) => (typeof e.score === 'number' && e.score > (m ?? -1) ? e.score : m), null);
    const acted = matches.some((e) => ['saved', 'applied', 'interview', 'offer', 'hired'].includes(e.outcome));
    const changed = Array.isArray(job.lastChangedFields) && job.lastChangedFields.length > 0;
    const lastSeen = typeof job.lastSeen === 'number' ? job.lastSeen : 0;
    let tier = 5;
    let reason = 'routine recheck';
    if (acted) { tier = 1; reason = 'user acted on this opportunity'; }
    else if (typeof best === 'number' && best >= 85) { tier = 2; reason = `match score ${best}`; }
    else if (changed) { tier = 3; reason = `changed: ${job.lastChangedFields.join(', ')}`; }
    else if (lastSeen && lastSeen < approachLine) { tier = 4; reason = 'approaching stale threshold'; }
    scored.push({ job, tier, reason, best: best ?? -1, lastSeen });
  }
  scored.sort((a, b) => a.tier - b.tier || b.best - a.best || (a.job.jobId < b.job.jobId ? -1 : 1));
  return scored.slice(0, Math.max(0, limit)).map(({ job, tier, reason }) => ({
    jobId: job.jobId,
    priority: ['', 'SAVED', 'HIGH_SCORE', 'CHANGED', 'APPROACHING_STALE', 'ROUTINE'][tier],
    reason,
    // Selection context (additive): lifecycle + last verification time travel
    // with the candidate so callers need no second lookup. Saved/applied jobs
    // are NEVER excluded by age — tier 1 matches on outcome alone.
    lifecycle: job.lifecycle || 'active',
    lastVerifiedAt: typeof job.lastVerifiedAt === 'string' ? job.lastVerifiedAt : null,
  }));
}

/**
 * Trailing run of NOT_FOUND observations for one provider on one record,
 * newest-first over the bounded verificationHistory. Drives evaluateAbsence
 * without a separate counter (history is sliced to maxHistory, far above any
 * sane absenceThreshold).
 */
export function consecutiveNotFoundStreak(record, provider) {
  const history = Array.isArray(record?.verificationHistory) ? record.verificationHistory : [];
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (!e) break;
    if (e.provider !== provider) continue; // other sources never break this source's streak
    if (e.status !== 'NOT_FOUND') break;
    n++;
  }
  return n;
}

/** Compact a provider evidence object for storage: known keys only, string values truncated. No HTML bodies. */
export function compactEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const out = {};
  for (const k of ['type', 'provider', 'source', 'observedAt', 'confidence', 'reason', 'pageTitle']) {
    const v = evidence[k];
    if (typeof v === 'string' && v) out[k] = v.slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Persist one verification result onto a canonical record: bounded history +
 * lastVerifiedAt + per-source latest map. Applies provider-reported CLOSED as
 * validated evidence. Verification is source-specific: each history entry
 * carries its provider, and verificationBySource keeps the latest observation
 * per provider so multi-source jobs never conflate one source's result with
 * another's. Returns { applied, closed } — closed only for valid explicit
 * evidence.
 */
export function recordVerification(store, jobId, result, { policy = null, now = Date.now() } = {}) {
  const p = policy || defaultLivenessPolicy();
  const record = store?.jobs?.[jobId];
  if (!record) return { applied: false, closed: false, reason: 'no such record' };
  const checkedAt = result?.checkedAt || new Date(now).toISOString();
  const history = Array.isArray(record.verificationHistory) ? record.verificationHistory : [];
  const evidence = compactEvidence(result?.evidence);
  history.push({
    provider: result?.provider || null,
    status: result?.status || 'UNKNOWN',
    checkedAt,
    runtimeMs: typeof result?.runtimeMs === 'number' ? result.runtimeMs : null,
    ...(evidence ? { evidence } : {}),
  });
  record.verificationHistory = history.slice(-p.maxHistory);
  record.lastVerifiedAt = new Date(now).toISOString();
  if (result?.provider) {
    const bySource = record.verificationBySource && typeof record.verificationBySource === 'object'
      ? record.verificationBySource
      : {};
    bySource[result.provider] = {
      status: result?.status || 'UNKNOWN',
      checkedAt,
      ...(evidence?.type ? { evidenceType: evidence.type } : {}),
    };
    record.verificationBySource = bySource;
  }
  if (result?.status === 'CLOSED' && result?.evidence) {
    const check = assertClosedEvidence(result.evidence);
    if (check.ok) {
      const applied = applyLiveness(store, jobId, { state: 'OBSERVED_CLOSED', reason: result.evidence.reason, evidence: result.evidence }, now);
      return { applied: applied.applied, closed: applied.applied };
    }
    return { applied: true, closed: false, reason: `invalid closure evidence rejected: ${check.reason}` };
  }
  return { applied: true, closed: false };
}

/**
 * Evaluate a NOT_FOUND observation against policy (§3). Returns a closure
 * decision — CLOSED only when the provider contract declares NOT_FOUND a
 * reliable signal AND policy allows repeated-absence closure AND the
 * threshold of consecutive NOT_FOUNDs is met. Otherwise STALE-guidance.
 */
export function evaluateAbsence({ jobId, provider, consecutiveNotFounds, policy = null }) {
  const p = policy || defaultLivenessPolicy();
  const reliable = provider?.verify?.reliableAbsence === true;
  if (p.closeOnRepeatedAbsence && reliable && consecutiveNotFounds >= p.absenceThreshold) {
    return {
      close: true,
      evidence: makeClosedEvidence({
        type: 'explicit-provider',
        provider: provider?.id || 'unknown',
        confidence: 'medium',
        reason: `${consecutiveNotFounds} consecutive NOT_FOUND observations (provider-declared reliable absence)`,
      }),
    };
  }
  return { close: false, reason: reliable ? 'below absence threshold' : 'provider does not declare NOT_FOUND reliable' };
}
