// search-quality tests — descriptive aggregation by provider, query family,
// score band, and profile; sufficiency flags; no judgments anywhere.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSearchQuality } from '../lib/search-quality.mjs';

const NOW = Date.now();
const rec = (id, o = {}) => ({
  jobId: id, title: 'Engineer', company: 'Acme', sources: o.sources || ['dice'],
  sourceQueryFamilies: o.families || {},
});
const entry = (jobId, o = {}) => ({
  jobId, profileId: o.profileId || 'pa', score: o.score ?? 80,
  band: o.band || 'strong', outcome: o.outcome || 'surfaced',
  viewed: o.viewed || false,
});
const run = (o = {}) => ({
  runId: o.runId || 'run1', status: 'COMPLETE',
  selectedProfileIds: o.profiles || ['pa'],
  providersRequested: o.requested || ['dice'],
  providerHealth: o.health || { dice: 'ACTIVE' },
  rawCounts: o.raw || { dice: 100 },
  normalizedCounts: o.norm || { dice: 90 },
  usAcceptedCounts: o.acc || { dice: 72 },
  freshCounts: o.fresh || { dice: 60 },
  duplicateCounts: o.dupes || { dice: 10 },
  canonicalAddedByProvider: o.added || { dice: 20 },
  canonicalUpdatedByProvider: o.updated || { dice: 5 },
  queryStats: o.queryStats || [],
});

describe('search-quality provider aggregation', () => {
  it('sums retrieval counters across runs without ranking', () => {
    const q = computeSearchQuality({ runs: [run(), run({ runId: 'run2', raw: { dice: 50 } })] });
    assert.equal(q.byProvider.dice.retrieved, 150);
    assert.equal(q.byProvider.dice.normalized, 180);
    assert.equal(q.byProvider.dice.accepted, 144);
    assert.equal(q.byProvider.dice.new, 40);
    assert.equal(q.byProvider.dice.changed, 10);
    assert.ok(!('rank' in q.byProvider.dice) && !('best' in q.byProvider.dice) && !('score' in q.byProvider.dice));
    assert.ok(!('ranking' in q) && !('bestProvider' in q));
  });

  it('attributes outcomes to every source on the record (documented approximation)', () => {
    const records = [rec('k1', { sources: ['dice', 'linkedin'] })];
    const history = [entry('k1', { score: 88, outcome: 'saved', viewed: true })];
    const q = computeSearchQuality({ records, historyEntries: history });
    for (const p of ['dice', 'linkedin']) {
      assert.equal(q.byProvider[p].matched, 1);
      assert.equal(q.byProvider[p].strong, 1);
      assert.equal(q.byProvider[p].viewed, 1);
      assert.equal(q.byProvider[p].saved, 1);
    }
  });
});

describe('search-quality family aggregation', () => {
  it('groups retrieved + outcomes by family from queryStats and record families', () => {
    const records = [rec('k1', { families: { dice: { '(q1)': 'exact' } } }), rec('k2', { families: { dice: { '(q2)': 'broader' } } })];
    const runs = [run({ queryStats: [
      { provider: 'dice', query: '(q1)', family: 'exact', retrieved: 100, normalized: 72, accepted: 60 },
      { provider: 'dice', query: '(q2)', family: 'broader', retrieved: 210, normalized: 103, accepted: 80 },
    ] })];
    const history = [entry('k1', { score: 90 }), entry('k2', { score: 60 })];
    const q = computeSearchQuality({ runs, records, historyEntries: history });
    assert.equal(q.byFamily.exact.retrieved, 100);
    assert.equal(q.byFamily.exact.matched, 1);
    assert.equal(q.byFamily.exact.strong, 1);
    assert.equal(q.byFamily.exact.recordsObserved, 1);
    assert.equal(q.byFamily.broader.retrieved, 210);
    assert.equal(q.byFamily.broader.strong, 0);
  });

  it('records without family data contribute elsewhere, not to families', () => {
    const q = computeSearchQuality({ records: [rec('k1')], historyEntries: [entry('k1')] });
    assert.deepEqual(Object.keys(q.byFamily), []);
    assert.equal(q.byProvider.dice.matched, 1);
  });
});

describe('search-quality bands and profiles', () => {
  it('exposes per-band outcomes plus high-score rejections', () => {
    const history = [
      entry('k1', { score: 90, band: 'strong', outcome: 'saved', viewed: true }),
      entry('k2', { score: 88, band: 'strong', outcome: 'rejected' }),
      entry('k3', { score: 70, band: 'review', outcome: 'viewed', viewed: true }),
    ];
    const q = computeSearchQuality({ historyEntries: history });
    assert.equal(q.byBand.strong.surfaced, 2);
    assert.equal(q.byBand.strong.saved, 1);
    assert.equal(q.byBand.strong.rejected, 1);
    assert.equal(q.byBand.strong.viewed, 1);
    assert.deepEqual(q.byBand.strong.highScoreRejections, [{ jobId: 'k2', profileId: 'pa', score: 88, band: 'strong' }]);
    assert.equal(q.byBand.review.viewed, 1);
  });

  it('keeps profiles independent — never merged', () => {
    const history = [
      entry('k1', { profileId: 'pa', outcome: 'saved', viewed: true }),
      entry('k2', { profileId: 'pa', outcome: 'viewed', viewed: true }),
      entry('k3', { profileId: 'pb', outcome: 'saved', viewed: true }),
    ];
    const q = computeSearchQuality({ historyEntries: history });
    assert.equal(q.byProfile.pa.surfaced, 2);
    assert.equal(q.byProfile.pa.saved, 1);
    assert.equal(q.byProfile.pb.surfaced, 1);
    assert.ok(!('combined' in q) && !('overall' in q.byProfile));
  });

  it('computes coverage gaps without scoring them', () => {
    const history = [entry('k1', { profileId: 'pa', score: 90 }), entry('k2', { profileId: 'pa', score: 50 })];
    const q = computeSearchQuality({
      runs: [run()],
      historyEntries: history,
      profileIntents: { pa: { families: ['exact', 'broader'], queries: ['(q1)', '(q2)'] } },
    });
    const c = q.coverage.pa;
    assert.equal(c.roleFamilies, 2);
    assert.equal(c.mergedQueries, 2);
    assert.equal(c.providersAttempted, 1);
    assert.equal(c.providersSuccessful, 1);
    assert.equal(c.opportunitiesSurfaced, 2);
    assert.equal(c.strongMatches, 1);
    assert.equal(c.opportunitiesWithNoStrong, 1);
    assert.ok(!('score' in c) && !('rating' in c) && !('grade' in c));
  });
});

describe('search-quality sufficiency', () => {
  it('marks small samples insufficient everywhere', () => {
    const q = computeSearchQuality({
      records: [rec('k1')],
      historyEntries: [entry('k1', { outcome: 'saved' })],
    });
    assert.equal(q.byProvider.dice.samples, 1);
    assert.equal(q.byProvider.dice.sufficient, false);
    assert.equal(q.byBand.strong.sufficient, false);
    assert.equal(q.byProfile.pa.sufficient, false);
    assert.equal(q.sample.sufficient, false);
  });

  it('marks large samples sufficient', () => {
    const history = [];
    const records = [];
    for (let i = 0; i < 40; i++) {
      history.push(entry(`k${i}`, { outcome: i % 2 ? 'saved' : 'viewed', viewed: true }));
      records.push(rec(`k${i}`));
    }
    const q = computeSearchQuality({ records, historyEntries: history });
    assert.equal(q.byProvider.dice.sufficient, true);
    assert.deepEqual(q.sample, { count: 40, sufficient: true });
  });
});
