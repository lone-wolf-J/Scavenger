// Confidence-based employer discovery.
//
// Job-board providers are not employers: for every board result we extract
// the employer, score the evidence, and triage:
//
//   HIGH   (confidence >= 0.8) -> eligible for automatic addition
//   MEDIUM (0.5 - 0.8)         -> discovery review queue (human decides)
//   LOW    (< 0.5)             -> rejected, with a stored reason
//
// Pure scoring (scoreEmployer); persistence helpers are separate so tests
// never touch disk.

import {
  normalizeCompanyIdentity,
  isBoardAsEmployer,
  isStaffingIntermediary,
  isGenericEmployerName,
} from './company-normalize.mjs';
import { classifyUsLocation } from './us-location.mjs';

export { normalizeCompanyIdentity };
export const HIGH_THRESHOLD = 0.8;
export const MEDIUM_THRESHOLD = 0.5;

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Score one board job's employer evidence.
 * @param {{company?: string, location?: string, url?: string, sourceCompanyUrl?: string}} job
 * @param {{sources?: string[]}} [opts]
 * @returns {{name: string, key: string, confidence: number, tier: 'high'|'medium'|'low', evidence: string[], rejectReason: string}}
 */
export function scoreEmployer(job, { sources = [] } = {}) {
  const name = String(job?.company || '').trim();
  const noEvidence = (rejectReason, evidence) => ({ name, key: '', confidence: 0, tier: 'low', evidence, rejectReason });
  if (!name) return noEvidence('missing-company', ['missing company field']);
  const key = normalizeCompanyIdentity(name);
  if (!key) return noEvidence('missing-company', ['company field has no usable signal']);
  if (isBoardAsEmployer(name)) {
    return { name, key, confidence: 0, tier: 'low', evidence: ['company is the job board itself'], rejectReason: 'board-as-employer' };
  }
  if (isGenericEmployerName(name)) {
    return { name, key, confidence: 0, tier: 'low', evidence: ['generic placeholder name'], rejectReason: 'generic-name' };
  }

  let score = 0.5;
  const evidence = ['company field present'];
  const staffing = isStaffingIntermediary(name);
  if (staffing) {
    score -= 0.15;
    evidence.push('staffing intermediary signal — review only');
  }
  const loc = classifyUsLocation(job?.location || '', { url: job?.url || '' });
  if (loc.verdict === 'us') {
    score += 0.2;
    evidence.push(`US location evidence: ${loc.evidence.join('; ')}`);
  } else if (loc.verdict === 'non-us') {
    score -= 0.3;
    evidence.push(`non-US location evidence: ${loc.evidence.join('; ')}`);
  } else {
    evidence.push('no US location evidence');
  }
  // An explicit company career URL (not the board's) ties the posting to a
  // real employer site.
  const careerUrl = String(job?.sourceCompanyUrl || '').trim();
  if (careerUrl) {
    try {
      const host = new URL(careerUrl).hostname.toLowerCase();
      if (!/(dice|linkedin|indeed|monster|ziprecruiter|careerbuilder|techfetch|benchinfo)\./.test(host)) {
        score += 0.1;
        evidence.push('company career URL found');
      }
    } catch { /* unparseable URL -> no signal */ }
  }
  const uniqSources = [...new Set(sources.filter(Boolean))];
  if (uniqSources.length > 1) {
    score += 0.05;
    evidence.push(`seen across ${uniqSources.length} sources (${uniqSources.join(', ')})`);
  }

  let confidence = clamp01(Math.round(score * 100) / 100);
  // Staffing intermediaries never auto-add: cap at medium.
  if (staffing && confidence >= HIGH_THRESHOLD) {
    confidence = 0.79;
    evidence.push('capped at medium: staffing intermediary');
  }
  const tier = confidence >= HIGH_THRESHOLD ? 'high' : confidence >= MEDIUM_THRESHOLD ? 'medium' : 'low';
  return {
    name,
    key,
    confidence,
    tier,
    evidence,
    rejectReason: tier === 'low' ? (staffing ? 'staffing-unverified' : loc.verdict === 'non-us' ? 'non-us-employer' : 'weak-evidence') : '',
  };
}

/**
 * Aggregate board jobs into triaged discovery decisions.
 * @param {Array<object>} jobs - board jobs (each with company/location/url/_discoverySource)
 * @param {{trackedKeys?: Set<string>}} [opts] - normalized names already tracked (skipped as existing)
 * @returns {{decisions: Array<object>, high: Array<object>, medium: Array<object>, low: Array<object>, existing: number}}
 */
export function aggregateDiscovery(jobs, { trackedKeys = new Set() } = {}) {
  const byKey = new Map();
  for (const job of jobs || []) {
    const name = String(job?.company || '').trim();
    const key = normalizeCompanyIdentity(name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { name, jobs: [], sources: new Set() });
    const bucket = byKey.get(key);
    bucket.jobs.push(job);
    if (job?._discoverySource) bucket.sources.add(job._discoverySource);
    // Prefer the longest display spelling ("Acme Corp" over "Acme").
    if (name.length > bucket.name.length) bucket.name = name;
  }
  const decisions = [];
  for (const [key, bucket] of byKey) {
    if (trackedKeys.has(key)) continue; // already tracked -> refresh path, not discovery
    const rep = bucket.jobs[0] || {};
    const scored = scoreEmployer(rep, { sources: [...bucket.sources] });
    decisions.push({
      ...scored,
      key,
      name: bucket.name,
      jobCount: bucket.jobs.length,
      sources: [...bucket.sources],
      exampleJobUrl: bucket.jobs.map((j) => j?.url).find((u) => typeof u === 'string' && u.trim()) || '',
      exampleLocation: bucket.jobs.map((j) => j?.location).find((l) => typeof l === 'string' && l.trim()) || '',
    });
  }
  // Count tracked skips separately.
  let existing = byKey.size - decisions.length;
  if (existing < 0) existing = 0;
  return {
    decisions,
    high: decisions.filter((d) => d.tier === 'high'),
    medium: decisions.filter((d) => d.tier === 'medium'),
    low: decisions.filter((d) => d.tier === 'low'),
    existing,
  };
}

/**
 * Merge medium-confidence decisions into a review-queue array.
 * Existing entries keep their status; sightings refresh evidence/lastSeen.
 */
export function mergeReviewQueue(queue, medium, nowIso) {
  const q = Array.isArray(queue) ? [...queue] : [];
  const byKey = new Map(q.map((e) => [e.key, e]));
  for (const d of medium) {
    const prev = byKey.get(d.key);
    if (prev) {
      prev.lastSeen = nowIso;
      prev.jobCount = (prev.jobCount || 0) + d.jobCount;
      prev.jobsFound = prev.jobCount;
      prev.evidence = [...new Set([...(prev.evidence || []), ...(d.evidence || [])])];
      for (const s of d.sources || []) if (!prev.sources.includes(s)) prev.sources.push(s);
      const titles = new Set([...(prev.relevantJobTitles || []), ...((d.relevantJobTitles || []))]);
      prev.relevantJobTitles = [...titles].slice(0, 5);
      if (typeof prev.confidence === 'number' && d.confidence > prev.confidence) prev.confidence = d.confidence;
      if (d.whyNotAutoAdded) prev.whyNotAutoAdded = d.whyNotAutoAdded;
      if (d.potentialCompanyUrl && !prev.potentialCompanyUrl) prev.potentialCompanyUrl = d.potentialCompanyUrl;
    } else {
      const entry = {
        key: d.key,
        name: d.name,
        company: d.company || d.name,
        confidence: d.confidence,
        tier: d.tier,
        evidence: d.evidence,
        sources: d.sources,
        jobCount: d.jobCount,
        jobsFound: d.jobsFound ?? d.jobCount,
        relevantJobTitles: d.relevantJobTitles || [],
        whyDiscovered: d.whyDiscovered || '',
        whyNotAutoAdded: d.whyNotAutoAdded || '',
        potentialCompanyUrl: d.potentialCompanyUrl || '',
        exampleJobUrl: d.exampleJobUrl,
        exampleLocation: d.exampleLocation,
        firstSeen: nowIso,
        lastSeen: nowIso,
        status: 'pending',
      };
      byKey.set(d.key, entry);
      q.push(entry);
    }
  }
  return q;
}
