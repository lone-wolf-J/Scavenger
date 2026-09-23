// Human-evaluation analysis (Phase 12 §11–12): evaluation labels vs
// Scavenger bands, joined AFTER independent labeling. Confusion-style
// factual summaries only — no accuracy score, no optimization. False
// negatives/positives carry retrieval paths so retrieval misses are never
// blamed on matching (or vice versa).

import { EVALUATION_LABELS } from './eval-corpus.mjs';

/**
 * Join blind evaluations with scored matches.
 * @param {Array} evaluations validated human evals
 * @param {Map|object} scoresByKey `${profileId}::${evaluationJobId}` → {score, band}
 */
export function compareLabelsToBands({ evaluations = [], scoresByKey = {} } = {}) {
  const get = typeof scoresByKey.get === 'function'
    ? (k) => scoresByKey.get(k)
    : (k) => scoresByKey[k];
  const perLabel = {};
  for (const l of EVALUATION_LABELS) {
    perLabel[l] = { count: 0, scored: 0, scores: [], bands: {}, avgScore: null, medianScore: null };
  }
  const joined = [];
  for (const e of Array.isArray(evaluations) ? evaluations : []) {
    if (!e || !EVALUATION_LABELS.includes(e.evaluationLabel)) continue;
    const cell = perLabel[e.evaluationLabel];
    cell.count++;
    const s = get(`${e.profileId}::${e.evaluationJobId}`);
    const row = { evaluationId: e.evaluationId, profileId: e.profileId, evaluationJobId: e.evaluationJobId, label: e.evaluationLabel, score: null, band: null };
    if (s && typeof s.score === 'number') {
      row.score = s.score;
      row.band = typeof s.band === 'string' ? s.band : s.band?.label || 'unbanded';
      cell.scored++;
      cell.scores.push(s.score);
      cell.bands[row.band] = (cell.bands[row.band] || 0) + 1;
    }
    joined.push(row);
  }
  for (const cell of Object.values(perLabel)) {
    cell.scores.sort((a, b) => a - b);
    cell.avgScore = cell.scores.length ? Math.round(cell.scores.reduce((a, b) => a + b, 0) / cell.scores.length) : null;
    cell.medianScore = cell.scores.length ? cell.scores[Math.floor(cell.scores.length / 2)] : null;
    delete cell.scores;
  }
  return { perLabel, joined };
}

/**
 * False-negative / false-positive investigation with retrieval paths (§12).
 * Each finding carries diagnostic contributors, missing evidence, penalties,
 * retrieval path (first-loss stage), and profile evidence pointers — never
 * a weight change.
 */
export function investigateLabelDeviations({ joined = [], diagnosticsByKey = {}, tracesByKey = {}, strongAt = 75 } = {}) {
  const get = (m, k) => (typeof m.get === 'function' ? m.get(k) : m[k]);
  const falseNegatives = [];
  const falsePositives = [];
  for (const row of Array.isArray(joined) ? joined : []) {
    if (row.score == null) continue;
    const key = `${row.profileId}::${row.evaluationJobId}`;
    const d = get(diagnosticsByKey, key) || null;
    const trace = get(tracesByKey, key) || null;
    const detail = {
      evaluationId: row.evaluationId, profileId: row.profileId, evaluationJobId: row.evaluationJobId,
      score: row.score, band: row.band,
      contributors: d ? d.positiveContributors.map((c) => `${c.key}+${c.points}/${c.max}`) : [],
      missingEvidence: d ? d.missingEvidence.slice(0, 6) : [],
      penalties: d ? d.penalties : [],
      retrievalPath: trace ? { status: trace.status, lossReason: trace.lossReason || null, provider: (trace.providers || [])[0] || null } : null,
    };
    if (row.label === 'CLEAR_MATCH' && row.score < strongAt) falseNegatives.push(detail);
    if (row.label === 'CLEAR_MISMATCH' && row.score >= strongAt) falsePositives.push(detail);
  }
  return { falseNegatives, falsePositives };
}
