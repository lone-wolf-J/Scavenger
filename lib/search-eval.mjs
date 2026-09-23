// Search evaluation framework — controlled, descriptive measurement of
// discovery + matching across arbitrary career profiles (Phase 10 §8–16).
//
// Evaluation fixtures only (tests/fixtures/eval-profiles/); the product
// architecture stays domain-free. This module never tunes anything: it runs
// the existing intent → discovery → match pipeline (dry-run by default, so
// evaluation never pollutes the store) and reports factual structure.
// Sufficiency flags mark thin evidence; gaps are listed, never "fixed".

import { buildSearchIntent } from './search-intent.mjs';
import { discoverForProfiles } from './discovery-engine.mjs';

export const DEFAULT_EVAL_SUFFICIENT = 30;

const sample = (count, threshold = DEFAULT_EVAL_SUFFICIENT) => ({ count, sufficient: count >= threshold });

/**
 * Evaluate one profile's search end to end.
 * @returns {Promise<object>} structured evaluation (see README in header)
 */
export async function evaluateProfileSearch({
  profileId = 'eval',
  profile,
  providerModules = null,
  providersDir = null,
  providers = null,
  maxQueries = 6,
  location = 'United States',
  maxAgeDays = 7,
  minScore = 0,
  now = Date.now(),
  dryRun = true,
} = {}) {
  if (!profile || typeof profile !== 'object') throw new Error('search-eval: profile object required');
  const selected = [{ id: profileId, profile }];
  const intent = buildSearchIntent(selected);
  const families = (intent.byProfile[0]?.families || []).map((f) => f?.name).filter(Boolean);

  const result = await discoverForProfiles({
    profiles: selected,
    providerModules,
    providersDir,
    providers: providers || undefined,
    maxQueries,
    location,
    maxAgeDays,
    dryRun,
    now,
  });

  const perProvider = {};
  for (const p of result.providers || []) {
    perProvider[p.id] = {
      status: p.status,
      retrieved: p.raw, normalized: p.normalized, accepted: p.accepted,
      fresh: p.fresh, duplicates: p.dupes, strong: p.highMatch,
      canonicalAdded: p.canonicalAdded, canonicalUpdated: p.canonicalUpdated,
      errorTypes: p.errorTypes || {},
    };
  }
  const queryStats = result.queryStats || [];
  const zeroResultQueries = queryStats.filter((q) => (q.retrieved || 0) === 0)
    .map((q) => ({ provider: q.provider, query: q.query, family: q.family }));
  const byFamily = {};
  for (const q of queryStats) {
    const f = q.family || 'unfamilied';
    const n = byFamily[f] || (byFamily[f] = { queries: 0, retrieved: 0, accepted: 0, strong: 0, zeroResult: 0 });
    n.queries++;
    n.retrieved += q.retrieved || 0;
    n.accepted += q.accepted || 0;
    if ((q.retrieved || 0) === 0) n.zeroResult++;
  }
  // Strong-per-family needs the match pool join: attribute pool bests back
  // through accepted sightings is not tracked per family, so family.strong
  // counts pool matches whose... — honest boundary: family strength is
  // measured at the record level by search-quality, not here. This runner
  // reports retrieval per family and matching globally.

  const pool = result.matches || [];
  const bands = {};
  const reasonFreq = {};
  const penaltyFreq = {};
  const signalFreq = {};
  let strong = 0;
  let belowFloor = 0;
  const samples = [];
  for (const agg of pool) {
    const best = agg.best || {};
    const band = typeof best.band === 'string' ? best.band : best.band?.label || 'unbanded';
    bands[band] = (bands[band] || 0) + 1;
    if (typeof best.score === 'number' && best.score >= 75) strong++;
    if (typeof best.score === 'number' && best.score < minScore) belowFloor++;
    for (const m of agg.matches || []) {
      for (const r of m.reasons || []) reasonFreq[r] = (reasonFreq[r] || 0) + 1;
      for (const p of m.penalties || []) penaltyFreq[p] = (penaltyFreq[p] || 0) + 1;
      for (const s of m.matchedSignals || []) signalFreq[s] = (signalFreq[s] || 0) + 1;
    }
  }
  const byScore = [...pool].map((a) => a.best?.score).filter((s) => typeof s === 'number').sort((a, b) => a - b);
  samples.push(
    ...[...pool].sort((a, b) => (b.best?.score || 0) - (a.best?.score || 0)).slice(0, 3).map((a) => ({ tier: 'strong', jobId: a.jobId, score: a.best?.score ?? null, reasons: (a.best?.reasons || a.matches?.[0]?.reasons || []).slice(0, 4) })),
    ...[...pool].sort((a, b) => (a.best?.score || 0) - (b.best?.score || 0)).slice(0, 3).map((a) => ({ tier: 'weak', jobId: a.jobId, score: a.best?.score ?? null, reasons: (a.best?.reasons || a.matches?.[0]?.reasons || []).slice(0, 4) })),
  );

  const failedProviders = (result.providers || []).filter((p) => (p.failed || 0) > 0 && (p.succeeded || 0) === 0)
    .map((p) => ({ provider: p.id, errorType: p.lastErrorType || 'unknown' }));
  const gaps = {
    zeroResultQueries: zeroResultQueries.length,
    zeroResultFamilies: Object.entries(byFamily).filter(([, n]) => n.retrieved === 0).map(([f]) => f),
    failedProviders,
    noStrongMatches: strong === 0,
    freshnessRemoved: (result.funnel?.us || 0) - (result.funnel?.fresh || 0),
    locationRemoved: (result.funnel?.raw || 0) - (result.funnel?.us || 0),
    belowScoreFloor: belowFloor,
  };

  return {
    profileId,
    intent: { families, queries: intent.queries },
    retrieval: {
      perProvider,
      totals: {
        retrieved: result.funnel?.raw || 0,
        normalized: (result.providers || []).reduce((a, p) => a + (p.normalized || 0), 0),
        accepted: result.jobsAccepted || 0,
        fresh: result.funnel?.fresh || 0,
        duplicates: result.jobsDeduplicated || 0,
      },
      sample: sample(result.jobsAccepted || 0),
    },
    families: byFamily,
    zeroResultQueries,
    matching: {
      matched: pool.length,
      strong,
      bands,
      scoreMin: byScore[0] ?? null,
      scoreMedian: byScore.length ? byScore[Math.floor(byScore.length / 2)] : null,
      scoreMax: byScore.length ? byScore[byScore.length - 1] : null,
      reasonFreq: top(reasonFreq, 15),
      penaltyFreq: top(penaltyFreq, 15),
      signalFreq: top(signalFreq, 15),
      sample: sample(pool.length),
    },
    gaps,
    samples,
    errors: result.errors || [],
  };
}

/**
 * Evaluate several profiles in ONE shared retrieval plan (retrieval-once:
 * overlapping intent executes once, matches fan out per profile).
 */
export async function evaluateSearchAcrossProfiles({ profiles = [], ...rest } = {}) {
  if (!Array.isArray(profiles) || !profiles.length) throw new Error('search-eval: profiles required');
  const selected = profiles.map((p) => ({ id: p.id, profile: p.profile }));
  const intent = buildSearchIntent(selected);
  const result = await discoverForProfiles({
    profiles: selected,
    providers: rest.providers || undefined,
    providerModules: rest.providerModules || null,
    providersDir: rest.providersDir || null,
    maxQueries: rest.maxQueries ?? 6,
    location: rest.location || 'United States',
    maxAgeDays: rest.maxAgeDays ?? 7,
    dryRun: rest.dryRun !== false,
    now: rest.now || Date.now(),
  });
  const uniqueQueries = new Set((result.queryStats || []).map((q) => `${q.provider} ${q.query}`));
  // Retrieval-once proof: merged shared queries vs the naive per-profile sum.
  let naiveSum = 0;
  for (const p of selected) naiveSum += buildSearchIntent([{ id: p.id, profile: p.profile }]).queries.length;
  const perProfile = {};
  for (const p of selected) {
    const m = result.matchesByProfile?.[p.id] || { matched: 0, highMatch: 0, avgScore: null };
    perProfile[p.id] = { ...m, sample: sample(m.matched) };
  }
  const multiSourced = (result.matches || []).filter((a) => (a.matches || []).length > 1);
  return {
    sharedPlan: {
      profiles: selected.length,
      mergedQueries: intent.queries.length,
      naivePerProfileSum: naiveSum,
      shared: intent.queries.length <= naiveSum,
      executedRetrievals: uniqueQueries.size,
    },
    perProfile,
    multiProfileMatches: multiSourced.length,
    providerStatus: Object.fromEntries((result.providers || []).map((p) => [p.id, p.status])),
    errors: result.errors || [],
  };
}

function top(freq, n) {
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([text, count]) => ({ text, count }));
}
