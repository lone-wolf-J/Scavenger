// Search-quality measurement — descriptive ONLY (Phase 9 §11–19).
//
// Aggregates retrieval + outcome behavior by provider, query family, score
// band, and profile. Returns factual counts; never ranks providers, never
// labels anything good/bad, never feeds back into weights, queries, or
// thresholds (Phase 9 is measurement — §18). Every aggregate carries
// {samples, sufficient} (threshold default 30, mirroring outcome-metrics);
// small samples are marked insufficient, never interpreted.
//
// Outcome→provider attribution is approximate and documented: a history
// entry names a canonical job, and credit goes to every source on that
// job's record (a saved job found on Dice + LinkedIn counts once under
// each). Family membership comes from record.sourceQueryFamilies
// (persisted by the engine since Phase 9); retrieval counts per family come
// from run queryStats. Runs/records without those fields simply contribute
// to the provider/band/profile aggregates, not the family one.

export const DEFAULT_QUALITY_SUFFICIENT = 30;

const OUTCOME_BUCKETS = ['viewed', 'saved', 'rejected', 'applied', 'interview', 'offer', 'hired'];

function outcomeNode() {
  return { matched: 0, strong: 0, viewed: 0, saved: 0, rejected: 0, applied: 0, interview: 0, offer: 0, hired: 0 };
}

function withSufficiency(node, samples, threshold) {
  return { ...node, samples, sufficient: samples >= threshold };
}

/**
 * @param {object} args
 * @param {Array} [args.runs] persisted discovery-run records
 * @param {Array} [args.records] canonical job records
 * @param {Array} [args.historyEntries] flat match-history entries
 * @param {object} [args.profileIntents] {profileId: {families: string[], queries: string[]}}
 * @param {number} [args.sufficientThreshold]
 * @param {number} [args.strongAt] score at/above which a match counts strong (default 75, matches engine highMatch)
 */
export function computeSearchQuality({
  runs = [],
  records = [],
  historyEntries = [],
  profileIntents = {},
  sufficientThreshold = DEFAULT_QUALITY_SUFFICIENT,
  strongAt = 75,
} = {}) {
  const byId = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (r && r.jobId) byId.set(r.jobId, r);
  }

  // ---- provider retrieval baseline (from durable run counters) ----
  const providers = {};
  const provNode = () => ({
    retrieved: 0, normalized: 0, accepted: 0, fresh: 0, duplicate: 0,
    new: 0, changed: 0, ...outcomeNode(),
  });
  const prov = (id) => (providers[id] || (providers[id] = provNode()));
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== 'object') continue;
    const add = (map, key) => {
      for (const [p, v] of Object.entries(map || {})) {
        if (typeof v === 'number' && v > 0) prov(p)[key] += v;
      }
    };
    add(run.rawCounts, 'retrieved');
    add(run.normalizedCounts, 'normalized');
    add(run.usAcceptedCounts, 'accepted');
    add(run.freshCounts, 'fresh');
    add(run.duplicateCounts, 'duplicate');
    add(run.canonicalAddedByProvider, 'new');
    add(run.canonicalUpdatedByProvider, 'changed');
  }

  // ---- outcome joins (history entry → record sources) ----
  const bands = {};
  const profiles = {};
  const profNode = () => ({ surfaced: 0, ...outcomeNode() });
  const bandNode = () => ({ surfaced: 0, ...outcomeNode(), highScoreRejections: [] });
  const entrySources = (e) => {
    const rec = byId.get(e?.jobId);
    const s = rec ? (Array.isArray(rec.sources) && rec.sources.length ? rec.sources : (rec.source ? [rec.source] : [])) : [];
    return [...new Set(s.filter((x) => typeof x === 'string' && x))];
  };
  const recordFamilies = (rec) => {
    const fams = new Set();
    const m = rec?.sourceQueryFamilies;
    if (m && typeof m === 'object') {
      for (const byQuery of Object.values(m)) {
        if (byQuery && typeof byQuery === 'object') {
          for (const f of Object.values(byQuery)) if (typeof f === 'string' && f) fams.add(f);
        }
      }
    }
    return fams;
  };

  // Family observation sets: distinct records + retrieval sums.
  const families = {};
  const famNode = () => ({ retrieved: 0, normalized: 0, accepted: 0, records: null, ...outcomeNode() });
  const fam = (name) => (families[name] || (families[name] = famNode()));
  for (const rec of byId.values()) {
    for (const f of recordFamilies(rec)) {
      const n = fam(f);
      if (!n.records) n.records = new Set();
      n.records.add(rec.jobId);
    }
  }
  for (const run of Array.isArray(runs) ? runs : []) {
    for (const q of (run && Array.isArray(run.queryStats) ? run.queryStats : [])) {
      if (!q || typeof q.family !== 'string' || !q.family) continue;
      const n = fam(q.family);
      n.retrieved += Number(q.retrieved) || 0;
      n.normalized += Number(q.normalized) || 0;
      n.accepted += Number(q.accepted) || 0;
    }
  }

  for (const e of Array.isArray(historyEntries) ? historyEntries : []) {
    if (!e || typeof e !== 'object' || !e.jobId) continue;
    const strong = typeof e.score === 'number' && e.score >= strongAt;
    const bucket = OUTCOME_BUCKETS.includes(e.outcome) ? e.outcome : null;
    const isViewed = e.viewed === true || e.outcome === 'viewed';
    const touch = (node) => {
      node.matched++;
      if (strong) node.strong++;
      // viewed counts once: the outcome bucket 'viewed' and the viewed flag
      // are two spellings of the same event.
      if (isViewed && e.outcome !== 'viewed') node.viewed++;
      if (bucket) node[bucket]++;
    };
    for (const s of entrySources(e)) touch(prov(s));
    const band = typeof e.band === 'string' && e.band ? e.band : 'unbanded';
    const bn = bands[band] || (bands[band] = bandNode());
    bn.surfaced++;
    touch(bn);
    if (e.outcome === 'rejected' && strong) {
      bn.highScoreRejections.push({ jobId: e.jobId, profileId: e.profileId || null, score: e.score, band: e.band || null });
    }
    if (typeof e.profileId === 'string' && e.profileId) {
      const pn = profiles[e.profileId] || (profiles[e.profileId] = profNode());
      pn.surfaced++;
      touch(pn);
    }
    const rec = byId.get(e.jobId);
    if (rec) {
      for (const f of recordFamilies(rec)) touch(fam(f));
    }
  }

  const byProvider = {};
  for (const [p, n] of Object.entries(providers)) byProvider[p] = withSufficiency(n, n.matched, sufficientThreshold);
  const byFamily = {};
  for (const [f, n] of Object.entries(families)) {
    const { records: recSet, ...rest } = n;
    byFamily[f] = {
      ...withSufficiency(rest, n.matched, sufficientThreshold),
      recordsObserved: recSet ? recSet.size : 0,
    };
  }
  const byBand = {};
  for (const [b, n] of Object.entries(bands)) byBand[b] = withSufficiency(n, n.surfaced, sufficientThreshold);
  const byProfile = {};
  for (const [p, n] of Object.entries(profiles)) byProfile[p] = withSufficiency(n, n.surfaced, sufficientThreshold);

  // ---- coverage (per profile, from intents + runs + outcomes) ----
  const coverage = {};
  const attemptedByProfile = {};
  const successfulByProfile = {};
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== 'object') continue;
    const okProviders = new Set();
    for (const [p, s] of Object.entries(run.providerHealth || {})) {
      if (s === 'ACTIVE') okProviders.add(p);
    }
    for (const pid of run.selectedProfileIds || []) {
      if (!attemptedByProfile[pid]) { attemptedByProfile[pid] = new Set(); successfulByProfile[pid] = new Set(); }
      for (const p of run.providersRequested || []) attemptedByProfile[pid].add(p);
      for (const p of okProviders) successfulByProfile[pid].add(p);
    }
  }
  for (const [pid, intent] of Object.entries(profileIntents || {})) {
    const fams = Array.isArray(intent?.families) ? intent.families : [];
    const qs = Array.isArray(intent?.queries) ? intent.queries : [];
    const prof = byProfile[pid];
    const surfaced = prof ? prof.surfaced : 0;
    const strong = prof ? prof.strong : 0;
    coverage[pid] = {
      roleFamilies: fams.length,
      mergedQueries: qs.length,
      providersAttempted: (attemptedByProfile[pid] || new Set()).size,
      providersSuccessful: (successfulByProfile[pid] || new Set()).size,
      opportunitiesSurfaced: surfaced,
      strongMatches: strong,
      opportunitiesWithNoStrong: Math.max(0, surfaced - strong),
      ...withSufficiency({}, surfaced, sufficientThreshold),
    };
  }

  const totalEntries = Array.isArray(historyEntries) ? historyEntries.length : 0;
  return {
    byProvider,
    byFamily,
    byBand,
    byProfile,
    coverage,
    sample: { count: totalEntries, sufficient: totalEntries >= sufficientThreshold },
  };
}
