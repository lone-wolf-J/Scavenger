// Match diagnostics — "is this score reasonable, and which signals caused
// it?" (Phase 11 §3–4).
//
// This module performs NO scoring of its own. It calls the real scorer
// (scoreJob/matchJob) and re-presents the returned breakdown with per-key
// maxima, reason/penalty linkage, recomputed assessments from the same
// exported primitives (seniorityOf, classifyUsLocation, termHits), and a
// deterministic explanation string. A diagnostic can never disagree with
// the score it explains: every number here is derived from the scorer's
// own output or its exported helpers.

import { scoreJob, seniorityOf, termHits, DEFAULT_WEIGHTS, scoreToBand } from './match-score.mjs';
import { normalizeCareerProfile } from './career-profile.mjs';
import { classifyUsLocation } from './us-location.mjs';

const REASON_KEYS = [
  [/^Strong title match/, 'title'],
  [/level scope/, 'seniority'],
  [/^Skill match/, 'skills'],
  [/^Domain match/, 'functional'],
  [/years experience fits scope/, 'experience'],
  [/^Identified employer|^Company career site|^Listed on/, 'company'],
  [/^Compensation meets target/, 'compensation'],
  [/^US remote|^US-based|^Matches remote preference/, 'location'],
  [/^Full-time role|^Matches employment preference/, 'employment'],
  [/^Leadership match/, 'leadership'],
];

/**
 * @param {{job: object, profile: object, now?: number}} args
 * @returns diagnostic object (all fields deterministic given inputs)
 */
export function diagnoseMatch({ job = {}, profile = {}, now = Date.now() } = {}) {
  const p = normalizeCareerProfile(profile);
  const scored = scoreJob(job, p);
  const breakdown = scored.breakdown || {};

  const reasonsByKey = {};
  for (const r of scored.reasons || []) {
    const hit = REASON_KEYS.find(([re]) => re.test(r));
    const key = hit ? hit[1] : 'other';
    if (!reasonsByKey[key]) reasonsByKey[key] = [];
    reasonsByKey[key].push(r);
  }

  const positiveContributors = [];
  const negativeContributors = [];
  for (const [key, max] of Object.entries(DEFAULT_WEIGHTS)) {
    const points = breakdown[key] ?? 0;
    const shortfall = Math.max(0, max - points);
    if (points > 0) {
      positiveContributors.push({ key, points, max, reasons: reasonsByKey[key] || [] });
    }
    if (shortfall > 0) {
      negativeContributors.push({ key, points, max, shortfall, reasons: reasonsByKey[key] || [] });
    }
  }
  positiveContributors.sort((a, b) => b.points - a.points);

  const title = job.title || '';
  const desc = job.description || '';
  const fullHay = `${title} ${desc}`;
  const skillTerms = [...(p.skills || []), ...(p.technologies || [])];
  const domainTerms = [...(p.functionalAreas || []), ...(p.domains || []), ...(p.industries || [])];
  const haySet = new Set(fullHay.toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length > 1));
  const termPresent = (t) => {
    const ts = String(t || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((x) => x.length > 1);
    return ts.length > 0 && ts.some((x) => haySet.has(x));
  };
  const missingEvidence = [
    ...skillTerms.filter((t) => !termPresent(t)).map((t) => `skill not evidenced in job: "${t}"`),
    ...domainTerms.filter((t) => !termPresent(t)).map((t) => `domain not evidenced in job: "${t}"`),
  ];
  if (job.salary?.min == null && !(p.compensationPrefs?.min > 0)) missingEvidence.push('no compensation data on either side');
  else if (job.salary?.min == null) missingEvidence.push('job carries no compensation figures');
  else if (!(p.compensationPrefs?.min > 0)) missingEvidence.push('profile sets no compensation target');
  if (!job.company) missingEvidence.push('job names no employer');
  if (!job.employmentType) missingEvidence.push('job carries no explicit employment type');
  if (!skillTerms.length) missingEvidence.push('profile lists no skills/technologies');
  if (p.yearsExperience == null) missingEvidence.push('profile states no years of experience');

  const gotLevel = seniorityOf(title);
  const wantLevel = p.seniority || 'senior';
  const location = classifyUsLocation(job.location || '', { url: job.url || '' });
  const empLower = String(job.employmentType || '').toLowerCase();
  const wantsRemote = (p.workplacePrefs || []).some((w) => /remote/i.test(w));

  const top = positiveContributors[0];
  const gaps = negativeContributors
    .filter((c) => c.shortfall >= c.max / 2)
    .sort((a, b) => b.shortfall - a.shortfall)
    .slice(0, 3)
    .map((c) => `${c.key} (+${c.points}/${c.max})`);
  const explanation =
    `${scored.score}/100 (${scored.band?.label || 'unbanded'}): ` +
    (top ? `strongest in ${top.key} (+${top.points}/${top.max})` : 'no positive contributor') +
    (gaps.length ? `; gaps in ${gaps.join(', ')}` : '; no major gaps') +
    ((scored.penalties || []).length ? `; penalties: ${(scored.penalties || []).length}` : '; no penalties');

  return {
    score: scored.score,
    band: { label: scored.band?.label || 'unbanded', min: scored.band?.min ?? 0 },
    breakdown: { ...breakdown },
    positiveContributors,
    negativeContributors,
    missingEvidence,
    penalties: [...(scored.penalties || [])],
    seniorityAssessment: { jobLevel: gotLevel, profileLevel: wantLevel, points: breakdown.seniority ?? 0, max: DEFAULT_WEIGHTS.seniority },
    roleAssessment: { points: breakdown.title ?? 0, max: DEFAULT_WEIGHTS.title, rolePhrases: [...(p.targetRoles || []), ...(p.currentRoles || [])] },
    locationAssessment: { verdict: location.verdict, evidence: location.evidence, points: breakdown.location ?? 0, max: DEFAULT_WEIGHTS.location },
    workplaceAssessment: { wantsRemote, jobLocation: job.location || '', points: breakdown.location ?? 0, max: DEFAULT_WEIGHTS.location },
    employmentAssessment: { detected: empLower || null, prefs: [...(p.employmentPrefs || [])], points: breakdown.employment ?? 0, max: DEFAULT_WEIGHTS.employment },
    compensationAssessment: { jobMin: job.salary?.min ?? null, wantMin: p.compensationPrefs?.min > 0 ? p.compensationPrefs.min : null, points: breakdown.compensation ?? 0, max: DEFAULT_WEIGHTS.compensation },
    explanation,
  };
}

/** Band distribution over scored matches (§15): fixed buckets, no judgment. */
export function bandDistribution(matches = []) {
  const buckets = { '0-24': 0, '25-49': 0, '50-74': 0, '75-100': 0 };
  const scores = [];
  for (const m of Array.isArray(matches) ? matches : []) {
    const s = typeof m?.score === 'number' ? m.score : (typeof m?.best?.score === 'number' ? m.best.score : null);
    if (s == null) continue;
    scores.push(s);
    if (s < 25) buckets['0-24']++;
    else if (s < 50) buckets['25-49']++;
    else if (s < 75) buckets['50-74']++;
    else buckets['75-100']++;
  }
  scores.sort((a, b) => a - b);
  return {
    buckets,
    count: scores.length,
    average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    median: scores.length ? scores[Math.floor(scores.length / 2)] : null,
  };
}

export { scoreToBand, termHits };
