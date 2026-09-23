// Job liveness verification — deterministic, evidence-based, history-safe.
//
// Observation states for one canonical job after a discovery run:
//   OBSERVED_ACTIVE — seen in provider results during a successful run.
//   OBSERVED_CLOSED — explicit closure evidence (provider-reported closed /
//                     removed / reliable detail 404), validated schema.
//   STALE           — clock-aged past staleAfterDays, no fresh observation.
//   UNKNOWN         — never successfully observed (no usable lastSeen).
//
// Critical semantics (§5, §16):
//   - BLOCKED / UNSUPPORTED / AUTH_REQUIRED / RATE_LIMITED / ERROR provider
//     outcomes are NEVER closure evidence. A provider failure is not evidence
//     that a job disappeared.
//   - COMPLETE runs: safe for full comparison (observed updates + missing
//     computation). Missing ≠ closed; missing only informs staleness review.
//   - PARTIAL runs: safe for observed updates only. NOT safe for
//     disappearance/closure conclusions.
//   - FAILED runs: do not modify liveness state based on absence at all.
//
// Closing a job never deletes anything: the canonical record, sources,
// firstSeen/lastSeen, match history, outcomes, and change history all stay.

import { classifyLifecycle } from './job-diff.mjs';

export const OBSERVED_ACTIVE = 'OBSERVED_ACTIVE';
export const OBSERVED_CLOSED = 'OBSERVED_CLOSED';
export const STALE = 'STALE';
export const UNKNOWN = 'UNKNOWN';

const CLOSED_TYPES = ['explicit-provider', 'verified-detail', 'manual', 'clock'];
const CLOSED_CONFIDENCE = ['high', 'medium'];

/**
 * Structured closure evidence (§6). Every closed job carries a reason trail;
 * clock-based closure is distinguishable from explicit provider closure.
 * { type, provider?, observedAt, source?, confidence, reason }
 */
export function assertClosedEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { ok: false, reason: 'closedEvidence must be an object' };
  }
  if (!CLOSED_TYPES.includes(evidence.type)) {
    return { ok: false, reason: `type must be one of ${CLOSED_TYPES.join(', ')}` };
  }
  if (!CLOSED_CONFIDENCE.includes(evidence.confidence)) {
    return { ok: false, reason: `confidence must be one of ${CLOSED_CONFIDENCE.join(', ')}` };
  }
  if (typeof evidence.reason !== 'string' || !evidence.reason.trim()) {
    return { ok: false, reason: 'reason is required' };
  }
  if (typeof evidence.observedAt !== 'string' || Number.isNaN(Date.parse(evidence.observedAt))) {
    return { ok: false, reason: 'observedAt must be an ISO date string' };
  }
  if (evidence.type !== 'clock' && evidence.type !== 'manual' && (typeof evidence.provider !== 'string' || !evidence.provider.trim())) {
    return { ok: false, reason: 'provider is required for provider-sourced closure' };
  }
  return { ok: true };
}

export function makeClosedEvidence({ type, provider = null, source = null, confidence = 'high', reason, observedAt = null, now = Date.now() }) {
  const evidence = {
    type,
    provider,
    source,
    confidence,
    reason: String(reason || ''),
    observedAt: observedAt || new Date(now).toISOString(),
  };
  const check = assertClosedEvidence(evidence);
  if (!check.ok) throw new Error(`invalid closedEvidence: ${check.reason}`);
  return evidence;
}

/**
 * Classify one record's observation given a run context (§5).
 * @param {object} record - canonical job record (may be null for unknown ids)
 * @param {object} ctx - { observed: boolean, runStatus, closedEvidence?, now?, staleAfterDays?, closedAfterDays? }
 */
export function classifyObservation(record, ctx = {}) {
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  if (ctx.closedEvidence) {
    const check = assertClosedEvidence(ctx.closedEvidence);
    if (!check.ok) return { state: UNKNOWN, reason: `invalid evidence rejected: ${check.reason}` };
    return { state: OBSERVED_CLOSED, reason: ctx.closedEvidence.reason };
  }
  if (!record || typeof record.lastSeen !== 'number') return { state: UNKNOWN, reason: 'never successfully observed' };
  if (ctx.observed === true && (ctx.runStatus === 'COMPLETE' || ctx.runStatus === 'PARTIAL')) {
    return { state: OBSERVED_ACTIVE, reason: 'seen in provider results' };
  }
  // Absence reasoning only on COMPLETE runs; PARTIAL/FAILED absence proves nothing.
  const lifecycle = classifyLifecycle(record, { now, staleAfterDays: ctx.staleAfterDays, closedAfterDays: ctx.closedAfterDays });
  if (lifecycle === 'closed') return { state: STALE, reason: 'aged past thresholds without fresh observation (closure needs evidence)' };
  if (lifecycle === 'stale') return { state: STALE, reason: 'not seen recently' };
  return { state: OBSERVED_ACTIVE, reason: 'recently seen' };
}

/** Run statuses safe for disappearance comparison (§16). Only COMPLETE. */
export function safeForClosure(runStatus) {
  return runStatus === 'COMPLETE';
}

/**
 * Consecutive-run diff (§8): previous COMPLETE run vs current COMPLETE run.
 * Uses compact observedJobIds snapshots — never job payloads.
 * @returns {{new: string[], unchanged: string[], missing: string[]}|{error: string}}
 */
export function diffConsecutiveRuns(previousRun, currentRun) {
  if (!previousRun || !currentRun) return { error: 'two runs required' };
  if (previousRun.status !== 'COMPLETE' || currentRun.status !== 'COMPLETE') {
    return { error: 'both runs must be COMPLETE; PARTIAL/FAILED runs are not safe diff bases' };
  }
  const prev = new Set(previousRun.observedJobIds || []);
  const curr = new Set(currentRun.observedJobIds || []);
  return {
    new: [...curr].filter((id) => !prev.has(id)),
    unchanged: [...curr].filter((id) => prev.has(id)),
    missing: [...prev].filter((id) => !curr.has(id)),
  };
}

/**
 * Apply a liveness observation to a store record without destroying history.
 * Only lifecycle/lifecycleAt/closedEvidence/lastSeen are touched; sources,
 * firstSeen, matches, and outcomes are never modified here.
 * @returns {{applied: boolean, state: string, reason: string}}
 */
export function applyLiveness(store, jobId, observation, now = Date.now()) {
  const record = store?.jobs?.[jobId];
  if (!record) return { applied: false, state: UNKNOWN, reason: 'no such record' };
  const { state, reason } = observation && typeof observation === 'object'
    ? observation
    : { state: UNKNOWN, reason: 'empty observation' };
  if (state === OBSERVED_ACTIVE) {
    record.lastSeen = now;
    if (record.lifecycle !== 'active' && !record.closedEvidence) {
      record.lifecycle = 'active';
      record.lifecycleAt = new Date(now).toISOString();
    }
    return { applied: true, state, reason };
  }
  if (state === OBSERVED_CLOSED) {
    const evidence = observation.evidence || null;
    const check = assertClosedEvidence(evidence);
    if (!check.ok) return { applied: false, state: UNKNOWN, reason: `invalid evidence rejected: ${check.reason}` };
    record.lifecycle = 'closed';
    record.lifecycleAt = new Date(now).toISOString();
    record.closedEvidence = evidence;
    return { applied: true, state, reason };
  }
  return { applied: false, state, reason };
}
