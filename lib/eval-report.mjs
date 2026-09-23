// Real-world discovery report builder (Phase 12 §23).
//
// Assembles independently-computed sections into a reviewable structure:
// Profile, Search intent, Providers, Retrieval funnel, Location loss,
// Freshness loss, Deduplication, Match distribution, Explanation audit,
// Human evaluation, False negatives, False positives. It NEVER produces an
// overall "Scavenger quality score" — the sections must not collapse into
// one number (asserted in tests).

export const EVAL_REPORT_VERSION = 'eval-report/1';

const SECTION_ORDER = [
  'profile', 'intent', 'providers', 'funnel', 'location', 'freshness',
  'dedup', 'match', 'explanation', 'human', 'falseNegatives', 'falsePositives',
];

/**
 * @param {object} args pre-computed sections (any subset) + corpusVersion
 * @returns {{version, generatedAt, corpusVersion, sections}}
 */
export function buildEvalReport({ corpusVersion = null, generatedAt = new Date().toISOString(), ...sections } = {}) {
  const out = { version: EVAL_REPORT_VERSION, generatedAt, corpusVersion, sections: {} };
  for (const name of SECTION_ORDER) {
    if (sections[name] !== undefined) out.sections[name] = sections[name];
  }
  for (const [name, value] of Object.entries(sections)) {
    if (!SECTION_ORDER.includes(name)) out.sections[name] = value;
  }
  return out;
}

/** Human-readable multi-line rendering of a report (CLI/dev review). */
export function renderEvalReport(report) {
  const lines = [`discovery evaluation (corpus ${report.corpusVersion || 'unversioned'})`];
  const s = report.sections || {};
  if (s.funnel) lines.push(`funnel: retrieved=${s.funnel.retrieved ?? '?'} accepted=${s.funnel.accepted ?? '?'} matched=${s.funnel.matched ?? '?'} strong=${s.funnel.strong ?? '?'}`);
  if (s.location) lines.push(`location: us=${s.location.usAccepted ?? '?'} foreign=${s.location.foreignRejected ?? '?'} ambiguous=${s.location.ambiguousRejected ?? '?'}`);
  if (s.freshness) lines.push(`freshness: fresh=${s.freshness.fresh ?? '?'} stale=${s.freshness.staleRejected ?? '?'} undated=${s.freshness.undated ?? '?'}`);
  if (s.dedup) lines.push(`dedup: canonical=${s.dedup.canonicalJobs ?? '?'} multi-source=${s.dedup.multiSource ?? '?'}`);
  if (s.match?.buckets) lines.push(`bands: ${Object.entries(s.match.buckets).map(([b, n]) => `${b}=${n}`).join(' ')}`);
  if (s.falseNegatives) lines.push(`false negatives: ${s.falseNegatives.length}${s.falseNegatives.map((f) => ` ${f.evaluationId}(${f.score})`).join(',')}`);
  if (s.falsePositives) lines.push(`false positives: ${s.falsePositives.length}`);
  if (s.explanation) lines.push(`explanations audited: ${s.explanation.checked ?? '?'} violations: ${(s.explanation.violations || []).length}`);
  return lines.join('\n');
}
