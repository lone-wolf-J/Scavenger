// Match history + outcome calibration model (Phase 3 §10–11, Phase 6 §8–10).
//
// Data model only: no workflow, no ML. Deterministic scoring stays; this
// records what happened so future calibration CAN use it.
//
// Logical identity (eventual multi-user): userId + profileId + jobId.
// Local seam: userId defaults to 'local'; the storage key stays
// `${profileId}::${jobId}` with userId recorded on the entry.
// Entry: { userId, jobId, profileId, score, band, scoringVersion,
//   firstScoredVersion, discoveryRunId, surfacedAt, reasons, penalties,
//   matchedSignals, missingSignals,
//   jobHash, profileHash, scoreChanged, jobChanged, profileChanged,
//   viewed, viewedAt, firstViewedAt, outcome, outcomeAt,
//   firstSavedAt, appliedAt, interviewAt, offerAt, hiredAt, rejectedAt,
//   createdAt, updatedAt }
// Outcomes: surfaced → viewed → saved → rejected → applied → interview →
//   offer → hired (forward-only enforced, with 'rejected' terminal-except).
// Only explicit user actions change outcome state — never inferred.

import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { atomicWriteJson, readJsonStrict } from './atomic-write.mjs';
import { normalizeJobUrl } from './job-dedup.mjs';

export const OUTCOMES = ['surfaced', 'viewed', 'saved', 'rejected', 'applied', 'interview', 'offer', 'hired'];

// Forward-only transitions; rejected is terminal (re-opening is a new match).
const ALLOWED = {
  surfaced: ['viewed', 'saved', 'rejected'],
  viewed: ['saved', 'rejected', 'applied'],
  saved: ['viewed', 'rejected', 'applied'],
  rejected: [],
  applied: ['interview', 'rejected'],
  interview: ['offer', 'rejected'],
  offer: ['hired', 'rejected'],
  hired: [],
};

const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

export function jobHash(job) {
  return shortHash(JSON.stringify([job?.title, job?.company, job?.location, job?.url, job?.postedAt]));
}

export function profileHash(profile) {
  return shortHash(JSON.stringify(profile));
}

export function emptyHistory() {
  return { version: 1, matches: {} };
}

export function loadHistory(historyPath) {
  if (!historyPath || !existsSync(historyPath)) return emptyHistory();
  const parsed = readJsonStrict(historyPath); // malformed → empty, never merged
  if (parsed && parsed.matches && typeof parsed.matches === 'object' && !Array.isArray(parsed.matches)) {
    return { version: 1, matches: parsed.matches };
  }
  return emptyHistory();
}

export function saveHistory(history, historyPath) {
  atomicWriteJson(historyPath, history);
}

/**
 * Record (or refresh) a match result. Change flags compare against the
 * previous entry: scoreChanged / jobChanged / profileChanged.
 * scoringVersion is stamped from the result; firstScoredVersion is set once
 * and never rewritten, so historical scores keep their version (§9).
 */
export function recordMatch(history, { jobId, profileId, result, job, profile, userId = 'local', now = Date.now(), discoveryRunId = null }) {
  const key = `${profileId}::${jobId}`;
  const prev = history.matches[key];
  const stamp = new Date(now).toISOString();
  const jh = jobHash(job);
  const ph = profileHash(profile);
  const entry = {
    userId: prev?.userId || userId,
    jobId, profileId,
    score: result.score, band: result.band?.label || result.band,
    scoringVersion: result.scoringVersion || prev?.scoringVersion || 'unknown',
    firstScoredVersion: prev?.firstScoredVersion || result.scoringVersion || 'unknown',
    // Provenance for future calibration (§18): which run surfaced this match
    // and when. Set once, never rewritten; descriptive only.
    discoveryRunId: prev?.discoveryRunId || discoveryRunId || null,
    surfacedAt: prev?.surfacedAt || stamp,
    reasons: result.reasons || [], penalties: result.penalties || [],
    matchedSignals: result.matchedSignals || [], missingSignals: result.missingSignals || [],
    jobHash: jh, profileHash: ph,
    scoreChanged: prev ? prev.score !== result.score : false,
    jobChanged: prev ? prev.jobHash !== jh : false,
    profileChanged: prev ? prev.profileHash !== ph : false,
    viewed: prev?.viewed || false, viewedAt: prev?.viewedAt || null,
    firstViewedAt: prev?.firstViewedAt || null, firstSavedAt: prev?.firstSavedAt || null,
    appliedAt: prev?.appliedAt || null, interviewAt: prev?.interviewAt || null,
    offerAt: prev?.offerAt || null, hiredAt: prev?.hiredAt || null, rejectedAt: prev?.rejectedAt || null,
    outcome: prev?.outcome || 'surfaced', outcomeAt: prev?.outcomeAt || stamp,
    createdAt: prev?.createdAt || stamp, updatedAt: stamp,
  };
  history.matches[key] = entry;
  return { entry, isNew: !prev };
}

/** Mark viewed (idempotent; first touch timestamp preserved). */
export function markViewed(history, { jobId, profileId, now = Date.now() }) {
  const entry = history.matches[`${profileId}::${jobId}`];
  if (!entry) return null;
  const stamp = new Date(now).toISOString();
  entry.viewed = true;
  entry.viewedAt = entry.viewedAt || stamp;
  entry.firstViewedAt = entry.firstViewedAt || stamp;
  if (entry.outcome === 'surfaced') {
    entry.outcome = 'viewed';
    entry.outcomeAt = stamp;
  }
  entry.updatedAt = stamp;
  return entry;
}

/**
 * Advance the outcome state machine. Illegal transitions are rejected
 * (returned, never applied) so calibration data stays trustworthy.
 * Stage timestamps are set on first arrival only (firstSavedAt etc.);
 * outcomeAt always reflects the latest transition.
 */
export function recordOutcome(history, { jobId, profileId, outcome, now = Date.now() }) {
  const entry = history.matches[`${profileId}::${jobId}`];
  if (!entry) return { entry: null, ok: false, reason: 'no match recorded' };
  if (!OUTCOMES.includes(outcome)) return { entry, ok: false, reason: `unknown outcome "${outcome}"` };
  if (outcome !== entry.outcome && !ALLOWED[entry.outcome].includes(outcome)) {
    return { entry, ok: false, reason: `illegal transition ${entry.outcome} → ${outcome}` };
  }
  const stamp = new Date(now).toISOString();
  entry.outcome = outcome;
  entry.outcomeAt = stamp;
  entry.updatedAt = stamp;
  if (outcome === 'viewed') { entry.viewed = true; entry.viewedAt = entry.viewedAt || stamp; entry.firstViewedAt = entry.firstViewedAt || stamp; }
  if (outcome === 'saved') entry.firstSavedAt = entry.firstSavedAt || stamp;
  if (outcome === 'applied') entry.appliedAt = entry.appliedAt || stamp;
  if (outcome === 'interview') entry.interviewAt = entry.interviewAt || stamp;
  if (outcome === 'offer') entry.offerAt = entry.offerAt || stamp;
  if (outcome === 'hired') entry.hiredAt = entry.hiredAt || stamp;
  if (outcome === 'rejected') entry.rejectedAt = entry.rejectedAt || stamp;
  return { entry, ok: true };
}

/**
 * Profile-aware intelligence view (§4): one canonical job with per-profile
 * score/reasons/status. Never duplicates the job.
 */
export function getJobView(history, { jobId, profileIds = [] }) {
  const profiles = {};
  for (const profileId of profileIds) {
    const entry = history.matches?.[`${profileId}::${jobId}`];
    if (!entry) continue;
    profiles[profileId] = {
      score: entry.score,
      band: entry.band,
      scoringVersion: entry.scoringVersion,
      reasons: entry.reasons || [],
      penalties: entry.penalties || [],
      outcome: entry.outcome,
      viewed: !!entry.viewed,
    };
  }
  return { jobId, profiles };
}

/**
 * One-time legacy key migration: history entries keyed `profileId::inbox:url`
 * (pre-canonical feed) move to `profileId::<canonicalKey>` via a URL index.
 * Pure + safe: an entry moves only when its target key is absent (never
 * overwrites real entries) and its jobId field is rewritten to match.
 * Both raw and normalized URL forms are tried, since inbox URLs were stored
 * verbatim while the store normalizes (trailing slashes, tracking params).
 * @param {object} history - match-history state (mutated in place)
 * @param {Map<string,string>} urlToCanonical - raw-or-normalized URL → canonical jobId
 * @returns {{migrated: number, skipped: number}} counts for transparency
 */
export function migrateLegacyKeys(history, urlToCanonical) {
  let migrated = 0;
  let skipped = 0;
  if (!history || typeof history.matches !== 'object' || !(urlToCanonical instanceof Map)) {
    return { migrated, skipped };
  }
  for (const key of Object.keys(history.matches)) {
    const sep = key.indexOf('::');
    if (sep < 0) { skipped++; continue; }
    const profileId = key.slice(0, sep);
    const jobPart = key.slice(sep + 2);
    if (!jobPart.startsWith('inbox:')) continue; // already canonical
    const rawUrl = jobPart.slice('inbox:'.length);
    const canonical = urlToCanonical.get(rawUrl) || urlToCanonical.get(normalizeJobUrl(rawUrl));
    if (!canonical) { skipped++; continue; }
    const target = `${profileId}::${canonical}`;
    if (history.matches[target]) { skipped++; continue; } // never overwrite
    const entry = history.matches[key];
    delete history.matches[key];
    history.matches[target] = { ...entry, jobId: canonical };
    migrated++;
  }
  return { migrated, skipped };
}
