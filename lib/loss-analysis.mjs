// Funnel-loss analysis (Phase 12 §15–17): where retrieved opportunities go.
// Location loss preserves explicit foreign-marker precedence (§15); freshness
// and dedup are counted from record fields. Descriptive only — thresholds
// are inputs, never changed here.

import { classifyUsLocation } from './us-location.mjs';

/** Location gate accounting over raw retrieved jobs. */
export function analyzeLocationLoss({ jobs = [] } = {}) {
  const out = {
    retrieved: 0, usAccepted: 0, foreignRejected: 0, ambiguousRejected: 0,
    remoteAccepted: 0, usBasedAccepted: 0, byEvidence: {},
  };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') continue;
    out.retrieved++;
    const v = classifyUsLocation(job.location || '', { url: job.url || '' });
    for (const e of v.evidence || []) out.byEvidence[e] = (out.byEvidence[e] || 0) + 1;
    if (v.verdict === 'us') {
      out.usAccepted++;
      if (/remote/i.test(job.location || '')) out.remoteAccepted++;
      else out.usBasedAccepted++;
    } else if (v.verdict === 'non-us') {
      out.foreignRejected++;
    } else {
      out.ambiguousRejected++;
    }
  }
  return out;
}

/** Freshness accounting over normalized jobs. */
export function analyzeFreshnessLoss({ jobs = [], maxAgeDays = 7, now = Date.now() } = {}) {
  const out = { retrieved: 0, fresh: 0, staleRejected: 0, undated: 0, byProvider: {} };
  const cutoff = now - maxAgeDays * 86_400_000;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') continue;
    out.retrieved++;
    const p = job.source || job._providerId || 'unknown';
    const n = out.byProvider[p] || (out.byProvider[p] = { retrieved: 0, fresh: 0, staleRejected: 0, undated: 0 });
    n.retrieved++;
    if (typeof job.postedAt !== 'number' || !Number.isFinite(job.postedAt)) { out.undated++; n.undated++; continue; }
    if (job.postedAt < cutoff) { out.staleRejected++; n.staleRejected++; }
    else { out.fresh++; n.fresh++; }
  }
  return out;
}

/** Dedup accounting over canonical store records. */
export function analyzeDedup({ records = [] } = {}) {
  const out = {
    canonicalJobs: 0, multiSource: 0, sourceCounts: {},
    bySourceCount: {}, totalObservations: 0,
  };
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    out.canonicalJobs++;
    const sources = [...new Set([...(rec.sources || []), ...(rec.source ? [rec.source] : [])].filter(Boolean))];
    out.totalObservations += Math.max(1, sources.length);
    out.bySourceCount[sources.length] = (out.bySourceCount[sources.length] || 0) + 1;
    if (sources.length > 1) out.multiSource++;
    for (const s of sources) out.sourceCounts[s] = (out.sourceCounts[s] || 0) + 1;
  }
  return out;
}
