// Outcome repository — measurement reads over match history (§10).
// Recording stays in match-repository (single writer); this namespace only
// answers "how useful has matching been" from persisted entries. No weights
// change here, no learning, no causality claims.

import { computeOutcomeMetrics } from '../outcome-metrics.mjs';
import { openMatchRepository } from './match-repository.mjs';

/**
 * @param {string} historyPath
 * @param {object} [scope] - {userId} tenancy seam; profileId narrows further
 */
export function openOutcomeRepository(historyPath, scope = {}) {
  const matches = openMatchRepository(historyPath);
  const userId = scope.userId || 'local';
  const entries = () => {
    const all = matches.getMatches({ userId });
    return scope.profileId ? all.filter((e) => e.profileId === scope.profileId) : all;
  };
  const asHistory = () => ({ version: 1, matches: Object.fromEntries(entries().map((e) => [`${e.profileId}::${e.jobId}`, e])) });
  return {
    path: historyPath,
    metrics: () => computeOutcomeMetrics(asHistory()),
    bandMatrix: () => bandOutcomeMatrix(entries()),
    signalTable: (limit = 25) => signalOutcomeTable(entries(), limit),
    profileCounts: () => profileMatchCounts(entries()),
    highScoreRejections: (threshold = 75) => highScoreRejections(entries(), threshold),
  };
}

const BANDS = ['exceptional', 'strong', 'review', 'weak', 'reject'];

/** band × outcome counts (descriptive). */
export function bandOutcomeMatrix(entries) {
  const matrix = Object.fromEntries(BANDS.map((b) => [b, {}]));
  for (const e of entries || []) {
    const band = BANDS.includes(e?.band) ? e.band : 'review';
    matrix[band][e?.outcome || 'surfaced'] = (matrix[band][e?.outcome || 'surfaced'] || 0) + 1;
  }
  return matrix;
}

/** signal → outcome counts, largest samples first; tiny samples flagged. */
export function signalOutcomeTable(entries, limit = 25) {
  const table = {};
  for (const e of entries || []) {
    for (const s of (e?.matchedSignals || []).slice(0, 10)) {
      const key = String(s).toLowerCase();
      table[key] = table[key] || { surfaced: 0, samples: 0 };
      table[key].samples++;
      table[key][e?.outcome || 'surfaced'] = (table[key][e?.outcome || 'surfaced'] || 0) + 1;
    }
  }
  return Object.entries(table)
    .sort((a, b) => b[1].samples - a[1].samples)
    .slice(0, limit)
    .map(([signal, row]) => ({ signal, ...row, sufficient: row.samples >= 30 }));
}

/** How many profiles matched the same job (descriptive; no causality). */
export function profileMatchCounts(entries) {
  const byJob = {};
  for (const e of entries || []) {
    if (!e?.jobId) continue;
    byJob[e.jobId] = byJob[e.jobId] || new Set();
    byJob[e.jobId].add(e.profileId);
  }
  const dist = {};
  for (const set of Object.values(byJob)) {
    const n = set.size;
    dist[n] = (dist[n] || 0) + 1;
  }
  return { jobs: Object.keys(byJob).length, byProfileCount: dist };
}

/** High-score jobs the user rejected anyway (calibration input, not verdict). */
export function highScoreRejections(entries, threshold = 75) {
  return (entries || [])
    .filter((e) => typeof e?.score === 'number' && e.score >= threshold && e.outcome === 'rejected')
    .map((e) => ({ jobId: e.jobId, profileId: e.profileId, score: e.score, band: e.band }));
}
