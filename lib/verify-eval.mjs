// Verification evaluation fixture framework — "when a provider says X, what
// did the fixture expect?" Tracks observed-vs-expected agreement per fixture
// with raw counts only. Deliberately NO precision/recall claims: fixture sets
// are tiny and partly synthetic, so any rate computed here would mislead.
// Each evaluation row carries its fixture classification (live-trimmed,
// synthetic, http-status) so readers can weight live evidence over synthetic
// branch coverage. Sufficient-sample flagging mirrors outcome-metrics.

export const DEFAULT_EVAL_SUFFICIENT = 30;

/**
 * @param {{providerId: string, classify: (res) => {status: string, evidenceType?: string}, fixtures: Array<{name: string, status?: number, html?: string, url?: string, expectedStatus: string, classification: string}>, sufficientThreshold?: number}} args
 * @returns {{provider: string, rows: Array, counts: {total: number, agree: number, disagree: number}, byStatus: object, sample: {count: number, sufficient: boolean}}}
 */
export function evaluateVerificationFixtures({ providerId, classify, fixtures, sufficientThreshold = DEFAULT_EVAL_SUFFICIENT }) {
  const rows = [];
  const byStatus = {};
  let agree = 0;
  for (const f of Array.isArray(fixtures) ? fixtures : []) {
    const out = classify({ status: f.status ?? 200, html: f.html ?? '', url: f.url ?? '' }) || {};
    const observedStatus = String(out.status || 'UNKNOWN').toUpperCase();
    const ok = observedStatus === String(f.expectedStatus || '').toUpperCase();
    if (ok) agree++;
    rows.push({
      name: f.name,
      classification: f.classification || 'synthetic',
      expectedStatus: f.expectedStatus,
      observedStatus,
      evidenceType: out.evidenceType || null,
      agree: ok,
    });
    const key = `${f.expectedStatus || '?'}→${observedStatus}`;
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  const total = rows.length;
  return {
    provider: providerId,
    rows,
    counts: { total, agree, disagree: total - agree },
    byStatus,
    sample: { count: total, sufficient: total >= sufficientThreshold },
  };
}
