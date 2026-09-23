// Profile-keyed matching — the primary abstraction (Phase 3 §9).
//
// matchJob(job, profile) evaluates ONE canonical shared job against ONE
// Career Profile. New profiles never require a rescan: matching is pure,
// local, and network-free.
//
// Result: { jobId, profileId, score, band, scoringVersion, reasons,
//           penalties, matchedSignals, missingSignals, createdAt, updatedAt }

import { normalizeCareerProfile } from './career-profile.mjs';
import { normalizeJob } from './job-model.mjs';
import { scoreJob, termHits } from './match-score.mjs';

/** Deterministic scoring version (§9). Bumped only with scoring-logic
 * changes; every persisted match records it, and firstScoredVersion in
 * history is never rewritten. */
export const MATCHER_VERSION = '1.0';

function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length > 1);
}

/**
 * @param {object} jobInput - normalized job or raw provider job
 * @param {object} profileInput - Career Profile (or legacy shape)
 * @param {{jobId?: string, profileId?: string, weights?: object, now?: number}} [opts]
 */
export function matchJob(jobInput, profileInput, { jobId, profileId, weights = {}, now = Date.now() } = {}) {
  const job = jobInput && typeof jobInput === 'object' ? jobInput : {};
  const normalized = job.title && job.url ? normalizeJob(job, job.source || 'unknown', now) : job;
  const profile = normalizeCareerProfile(profileInput);
  const scored = scoreJob(normalized, profile, weights);
  const hay = new Set(tokens(`${normalized.title || ''} ${normalized.description || ''}`));
  const skillTerms = [...profile.skills, ...profile.technologies];
  const funcTerms = [...profile.functionalAreas, ...profile.domains, ...profile.industries];
  const matchedSignals = [
    ...termHits(skillTerms, hay).slice(0, 8),
    ...termHits(funcTerms, hay).slice(0, 4),
    ...termHits(profile.leadershipSignals, hay).slice(0, 3),
  ];
  const missingSignals = [
    ...skillTerms.filter((t) => !termHits([t], hay).length).slice(0, 5),
    ...funcTerms.filter((t) => !termHits([t], hay).length).slice(0, 3),
  ];
  const stamp = new Date(now).toISOString();
  return {
    jobId: jobId || normalized.id || `${normalized.source}:${normalized.url || normalized.title}`,
    profileId: profileId || 'default',
    score: scored.score,
    band: scored.band,
    scoringVersion: MATCHER_VERSION,
    reasons: scored.reasons,
    penalties: scored.penalties,
    breakdown: scored.breakdown,
    matchedSignals,
    missingSignals,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * Match ONE job against MANY profiles. Each opportunity is returned once,
 * carrying every profile's score and explanation — the display layer shows
 * the job a single time with per-profile breakdowns.
 *
 * @param {object} jobInput - one normalized (or raw) job
 * @param {Array<{id?: string, profile: object}>} profiles
 * @returns {{jobId, best: object, matches: Array<object>}} best = highest score
 */
export function matchJobMany(jobInput, profiles, opts = {}) {
  const matches = (Array.isArray(profiles) ? profiles : []).map((p, i) =>
    matchJob(jobInput, p.profile || p, {
      profileId: p.id || p.profileId || `profile-${i}`,
      weights: opts.weights || {},
      now: opts.now,
    }),
  ).sort((a, b) => b.score - a.score);
  return {
    jobId: matches[0]?.jobId || '',
    best: matches[0] || null,
    matches,
  };
}

/**
 * Match a shared job pool against selected profiles, aggregated by job.
 * Sorts by best score; jobs matching nothing above `minScore` are dropped
 * (default 0 keeps everything — filtering is the caller's policy).
 */
export function matchPool(jobs, profiles, { minScore = 0, weights = {}, now = Date.now() } = {}) {
  return (Array.isArray(jobs) ? jobs : [])
    .map((job) => matchJobMany(job, profiles, { weights, now }))
    .filter((agg) => agg.best && agg.best.score >= minScore)
    .sort((a, b) => b.best.score - a.best.score);
}
