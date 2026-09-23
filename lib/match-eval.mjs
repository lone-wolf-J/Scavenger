// Match-evaluation framework (Phase 11 §6–15).
//
// Runs labeled cases (tests/fixtures/match-eval-cases.json) through the real
// scorer + diagnostics, separates retrieval misses from match misses, and
// attributes low scores to cause categories A–J (§5) by measurement. Never
// tunes, never reweights, never rethresholds — findings are reported, and
// only concrete deterministic defects may be fixed (and versioned).

import { matchJob } from './matcher.mjs';
import { diagnoseMatch } from './match-diagnostics.mjs';
import { buildSearchIntent } from './search-intent.mjs';
import { DEFAULT_WEIGHTS } from './match-score.mjs';

// Cause categories (§5), assigned by measurement rules below.
export const CAUSES = {
  A: 'role mismatch',
  B: 'seniority mismatch',
  C: 'missing evidence',
  D: 'location filtering',
  E: 'workplace mismatch',
  F: 'employment mismatch',
  G: 'overly strong penalties',
  H: 'insufficient target-role inference',
  I: 'insufficient profile evidence',
  J: 'retrieval/query coverage',
};

// Retrieval outcomes (§9). A job the pipeline never saw is never a matcher
// failure; each stage is checkable independently.
export const RETRIEVAL_STATUSES = [
  'NOT_RETRIEVED', 'FILTERED_TITLE', 'FILTERED_LOCATION', 'FILTERED_FRESHNESS',
  'DUPLICATED', 'MATCHED_LOW', 'MATCHED_HIGH',
];

/**
 * Score one case + diagnose. Pure match stage (no retrieval).
 */
export function evaluateMatchCase({ id, profileId, profile, job, expected = {}, now = 0 } = {}) {
  const m = matchJob(job, profile, { jobId: id || 'eval', profileId: profileId || 'eval', now });
  const d = diagnoseMatch({ job, profile, now });
  return {
    id: id || null,
    profileId: profileId || null,
    score: m.score,
    band: typeof m.band === 'string' ? m.band : m.band?.label || 'unbanded',
    matchedSignals: m.matchedSignals || [],
    missingSignals: m.missingSignals || [],
    penalties: m.penalties || [],
    reasons: m.reasons || [],
    expected,
    diagnostic: d,
  };
}

/** False negative: expected CLEAR_MATCH but scored below strong. */
export function isFalseNegative(result, strongAt = 75) {
  return result?.expected?.relevance === 'CLEAR_MATCH' && typeof result?.score === 'number' && result.score < strongAt;
}

/** False positive: expected CLEAR_MISMATCH but scored at/above strong. */
export function isFalsePositive(result, strongAt = 75) {
  return result?.expected?.relevance === 'CLEAR_MISMATCH' && typeof result?.score === 'number' && result.score >= strongAt;
}

/**
 * Attribute a low score to cause categories by measuring the diagnostic:
 * the dominant shortfall key maps to a cause; vetoes map to G; retrieval
 * status maps to J/D. Returns ordered [{cause, code, lostPoints, detail}].
 */
export function attributeShortfall({ diagnostic, retrievalStatus = null, vetoed = false } = {}) {
  const out = [];
  if (!diagnostic) return out;
  if (retrievalStatus && retrievalStatus !== 'MATCHED_LOW' && retrievalStatus !== 'MATCHED_HIGH') {
    const code = retrievalStatus === 'FILTERED_LOCATION' ? 'D' : 'J';
    out.push({ code, cause: CAUSES[code], lostPoints: null, detail: `job never reached matching (${retrievalStatus})` });
    return out;
  }
  if (vetoed || (diagnostic.penalties || []).includes('Capped: exclusion veto')) {
    out.push({ code: 'G', cause: CAUSES.G, lostPoints: null, detail: 'exclusion/junior veto capped the score at 20' });
  }
  const keyCause = { title: 'A', seniority: 'B', skills: 'C', functional: 'C', experience: 'B', company: null, compensation: null, location: 'D', employment: 'F', leadership: 'C' };
  const ranked = (diagnostic.negativeContributors || [])
    .filter((c) => c.shortfall > 0 && keyCause[c.key])
    .sort((a, b) => b.shortfall - a.shortfall);
  for (const c of ranked.slice(0, 3)) {
    const code = keyCause[c.key];
    let detail = `${c.key} contributed +${c.points}/${c.max}`;
    if (c.key === 'title') detail += ' — check H (role inference) and I (profile roles) alongside A';
    if (c.key === 'skills' || c.key === 'functional') detail += ' — C (job lacks terms) vs I (profile lacks terms): see missingEvidence';
    out.push({ code, cause: CAUSES[code], lostPoints: c.shortfall, detail });
  }
  return out;
}

/**
 * Classify where a known job stands relative to a pipeline run (§9).
 * Stages are explicit inputs so tests need no pipeline:
 * {inRaw, normalized, usAccepted, fresh, canonical, matchedBest (score|null)}.
 */
export function classifyRetrievalStatus({ inRaw = false, normalized = false, usAccepted = false, fresh = false, canonical = false, matchedBest = null, strongAt = 75 } = {}) {
  if (!inRaw) return 'NOT_RETRIEVED';
  if (!normalized) return 'FILTERED_TITLE';
  if (!usAccepted) return 'FILTERED_LOCATION';
  if (!fresh) return 'FILTERED_FRESHNESS';
  if (!canonical) return 'DUPLICATED';
  if (typeof matchedBest !== 'number') return 'MATCHED_LOW';
  return matchedBest >= strongAt ? 'MATCHED_HIGH' : 'MATCHED_LOW';
}

/**
 * Intent diagnostics (§10): what the profile generates, and which queries
 * could reasonably have retrieved each expected job (token overlap with the
 * job title/company — a coverage hypothesis, never a retrieval claim).
 */
export function diagnoseIntent({ profileId = 'eval', profile, jobs = [] } = {}) {
  const intent = buildSearchIntent([{ id: profileId, profile }]);
  const families = (intent.byProfile[0]?.families || []).map((f) => f?.name).filter(Boolean);
  const sig = (s) => String(s || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length > 2);
  const perJob = (Array.isArray(jobs) ? jobs : []).map((job) => {
    const hay = new Set([...sig(job?.title), ...sig(job?.company)]);
    const plausibleQueries = intent.queries.filter((q) => sig(q).some((t) => hay.has(t)));
    return { jobId: job?.jobId || job?.url || null, plausibleQueries };
  });
  return {
    profileId,
    targetRoles: [...(profile?.targetRoles || [])],
    families,
    queries: intent.queries,
    perJob,
  };
}

/**
 * Summarize an evaluated set: label×band matrix, FN/FP lists, cause counts.
 */
export function summarizeEvalSet(results = []) {
  const labels = ['CLEAR_MATCH', 'PLAUSIBLE_MATCH', 'UNCLEAR', 'CLEAR_MISMATCH'];
  const matrix = {};
  for (const l of labels) matrix[l] = { count: 0, bands: {}, avgScore: null, scores: [] };
  const falseNegatives = [];
  const falsePositives = [];
  const causes = {};
  for (const r of results) {
    const label = labels.includes(r?.expected?.relevance) ? r.expected.relevance : 'UNCLEAR';
    const cell = matrix[label];
    cell.count++;
    cell.bands[r.band] = (cell.bands[r.band] || 0) + 1;
    if (typeof r.score === 'number') cell.scores.push(r.score);
    if (isFalseNegative(r)) falseNegatives.push({ id: r.id, score: r.score, band: r.band });
    if (isFalsePositive(r)) falsePositives.push({ id: r.id, score: r.score, band: r.band });
    for (const a of attributeShortfall({ diagnostic: r.diagnostic, retrievalStatus: r.retrievalStatus || null, vetoed: (r.penalties || []).includes('Capped: exclusion veto') })) {
      const key = `${a.code}: ${a.cause}`;
      causes[key] = (causes[key] || 0) + 1;
    }
  }
  for (const cell of Object.values(matrix)) {
    cell.avgScore = cell.scores.length ? Math.round(cell.scores.reduce((a, b) => a + b, 0) / cell.scores.length) : null;
    cell.medianScore = cell.scores.length ? [...cell.scores].sort((a, b) => a - b)[Math.floor(cell.scores.length / 2)] : null;
    delete cell.scores;
  }
  return { matrix, falseNegatives, falsePositives, causes };
}

export { DEFAULT_WEIGHTS };
