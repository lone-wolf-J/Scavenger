// Opportunity result filters — pure, domain-neutral (Phase 4 §10, Phase 6 §7).
//
// Operates on aggregated multi-profile results (matcher.matchPool shape):
// [{ jobId, best, matches }] joined against canonical store records plus
// match/history state. Each filter is independent; combined filters AND
// together. Absent filters never exclude.

import { seniorityOf } from './title-gate.mjs';

const HOUR = 3600_000;

function jobOf(agg, jobsById) {
  return (jobsById && jobsById.get(agg.jobId)) || {};
}

/**
 * @param {Array} aggregated - matchPool() output
 * @param {object} filters - {profileId?, minScore?, seniority?, location?,
 *   workplace?, employment?, maxAgeDays?, company?, source?,
 *   isNew?, changed?, highConfidence?, minScoreDelta?, minProfiles?,
 *   lifecycle?, provider?, sinceRunAt?}
 * @param {Map} [jobsById] - jobId → canonical store record
 * @param {object} [extra] - {prevScores?: Map(`${profileId}::${jobId}` → score), now?: number}
 */
export function filterOpportunities(aggregated, filters = {}, jobsById = new Map(), extra = {}) {
  const f = filters || {};
  const now = Number.isFinite(extra.now) ? extra.now : Date.now();
  const prevScores = extra.prevScores || new Map();
  return (Array.isArray(aggregated) ? aggregated : []).filter((agg) => {
    const job = jobOf(agg, jobsById);
    if (f.profileId) {
      const m = (agg.matches || []).find((x) => x.profileId === f.profileId);
      if (!m || (f.minScore != null && m.score < f.minScore)) return false;
    } else if (f.minScore != null && (agg.best?.score ?? 0) < f.minScore) return false;
    if (f.seniority && seniorityOf(job.title) !== String(f.seniority).toLowerCase()) return false;
    if (f.location && !String(job.location || '').toLowerCase().includes(String(f.location).toLowerCase())) return false;
    if (f.workplace) {
      const w = String(job.workplaceType || job.location || '').toLowerCase();
      if (!w.includes(String(f.workplace).toLowerCase())) return false;
    }
    if (f.employment && String(job.employmentType || '').toLowerCase() !== String(f.employment).toLowerCase()) return false;
    if (f.maxAgeDays != null && typeof job.postedAt === 'number') {
      if (now - job.postedAt > f.maxAgeDays * 24 * HOUR) return false;
    }
    if (f.company && !String(job.company || '').toLowerCase().includes(String(f.company).toLowerCase())) return false;
    if (f.source && !(agg.matches.some((m) => (job.sources || [job.source]).includes(f.source)))) return false;
    // ---- Phase 6 intelligence filters (canonical + history state) ----
    if (f.isNew && !(typeof job.firstSeen === 'number' && f.sinceRunAt != null && job.firstSeen > f.sinceRunAt)) return false;
    if (f.changed && !(Array.isArray(job.lastChangedFields) && job.lastChangedFields.length > 0)) return false;
    if (f.highConfidence && (agg.best?.score ?? 0) < 75) return false;
    if (f.minScoreDelta != null) {
      const deltas = (agg.matches || []).map((m) => m.score - (prevScores.get(`${m.profileId}::${agg.jobId}`) ?? m.score));
      if (!deltas.some((d) => d >= f.minScoreDelta)) return false;
    }
    if (f.minProfiles != null && (agg.matches || []).length < f.minProfiles) return false;
    if (f.lifecycle && job.lifecycle !== f.lifecycle) return false;
    if (f.provider && !((job.sources || [job.source]).includes(f.provider))) return false;
    return true;
  });
}
