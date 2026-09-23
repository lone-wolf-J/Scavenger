import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeDescription, descriptionHash, diffJobs, classifyLifecycle, refreshLifecycle,
} from '../lib/job-diff.mjs';
import { emptyStore, loadStore, saveStore, upsertJobs, getJob } from '../lib/job-store.mjs';
import {
  emptyHistory, recordMatch, markViewed, recordOutcome, getJobView,
} from '../lib/match-history.mjs';
import { matchJob, MATCHER_VERSION } from '../lib/matcher.mjs';
import { computeOutcomeMetrics } from '../lib/outcome-metrics.mjs';
import { buildChangeFeed, feedSummary } from '../lib/change-feed.mjs';
import { filterOpportunities } from '../lib/opportunity-filters.mjs';

const NOW = Date.now();
const DAY = 86_400_000;
const tmpRoot = () => mkdtempSync(join(tmpdir(), 'scav-intel-'));

const BASE = {
  jobId: 'key:acme::hr director::il::2026-09-01',
  title: 'HR Director', company: 'Acme', location: 'Chicago, IL',
  url: 'https://a/1', postedAt: Date.parse('2026-09-01'),
  description: '<p>Lead <b>talent acquisition</b>!  Workday.</p>',
};
const resultFor = (score) => ({
  score, band: { label: score >= 75 ? 'review' : 'weak' }, scoringVersion: MATCHER_VERSION,
  reasons: ['r'], penalties: [], matchedSignals: ['Workday'], missingSignals: [],
});

describe('job-diff + lifecycle (§13)', () => {
  it('description normalization is deterministic across noise variants', () => {
    const variants = [
      '<p>Lead <b>talent acquisition</b>!  Workday.</p>',
      '<div>lead TALENT   acquisition! workday.</div>',
      'Lead talent acquisition! Workday. See https://x.io/jobs?utm_source=dice&ref=1 for details'.replace(' for details', ''),
    ];
    const hashes = new Set(variants.map(descriptionHash));
    assert.ok(hashes.size <= 2, [...hashes].join(','));
    assert.equal(descriptionHash(variants[0]), descriptionHash(variants[1]));
    assert.ok(normalizeDescription(variants[0]).length > 10);
  });
  it('NEW vs UNCHANGED vs CHANGED classification', () => {
    assert.equal(diffJobs(null, BASE, NOW).state, 'NEW');
    assert.deepEqual(diffJobs(BASE, { ...BASE }, NOW).state, 'UNCHANGED');
    const changed = diffJobs(BASE, { ...BASE, title: 'Senior HR Director', salary: { min: 150000 } }, NOW);
    assert.equal(changed.state, 'CHANGED');
    assert.ok(changed.changedFields.includes('title') && changed.changedFields.includes('salary'));
    assert.ok(changed.previous.descriptionHash && changed.current.descriptionExcerpt.length <= 200);
    assert.ok(!('description' in changed.previous) || typeof changed.previous.description === 'undefined');
  });
  it('volatile metadata alone is UNCHANGED', () => {
    const d = diffJobs(BASE, { ...BASE, lastSeen: NOW, seenCount: 9, sources: ['a', 'b'] }, NOW);
    assert.equal(d.state, 'UNCHANGED');
    assert.deepEqual(d.changedFields, []);
  });
  it('lifecycle: active → stale → closed; failure never closes', () => {
    assert.equal(classifyLifecycle({ lastSeen: NOW - DAY }, { now: NOW }), 'active');
    assert.equal(classifyLifecycle({ lastSeen: NOW - 45 * DAY }, { now: NOW }), 'stale');
    assert.equal(classifyLifecycle({ lastSeen: NOW - 200 * DAY }, { now: NOW }), 'closed');
    assert.equal(classifyLifecycle({ lastSeen: NOW - DAY, closedEvidence: 'verified 404' }, { now: NOW }), 'closed');
    // Provider failure is not an input: a recently seen job stays active
    // regardless of any outage narrative attached elsewhere.
    assert.equal(classifyLifecycle({ lastSeen: NOW - DAY, lastProviderError: 'BLOCKED' }, { now: NOW }), 'active');
  });
  it('refreshLifecycle ages the store without deleting', () => {
    const store = emptyStore();
    store.jobs.a = { jobId: 'a', lastSeen: NOW - DAY };
    store.jobs.b = { jobId: 'b', lastSeen: NOW - 45 * DAY };
    store.jobs.c = { jobId: 'c', lastSeen: NOW - 200 * DAY };
    const r = refreshLifecycle(store, { now: NOW });
    assert.deepEqual([r.active, r.stale, r.closed], [1, 1, 1]);
    assert.equal(Object.keys(store.jobs).length, 3);
    assert.equal(store.jobs.b.lifecycle, 'stale');
  });
});

describe('store integration (§13)', () => {
  it('upsert reports meaningful changes; metadata-only stays out of changes[]', () => {
    const store = emptyStore();
    const job = { ...BASE, source: 'dice', description: 'Lead talent acquisition. Workday.' };
    assert.deepEqual(upsertJobs(store, [job], NOW).changes, []);
    const meta = upsertJobs(store, [{ ...job, source: 'linkedin', url: 'https://a/1' }], NOW + 1);
    assert.equal(meta.updated, 1);
    assert.deepEqual(meta.changes, []); // new source ≠ meaningful change
    const real = upsertJobs(store, [{ ...job, source: 'dice', title: 'Senior HR Director' }], NOW + 2);
    assert.equal(real.updated, 1);
    assert.deepEqual(real.changes, [{ jobId: BASE.jobId, changedFields: ['title'] }]);
    const rec = getJob(store, BASE.jobId);
    assert.equal(rec.title, 'Senior HR Director');
    assert.ok(rec.lastChangedAt && rec.lastChangedFields.includes('title'));
    assert.equal(rec.lifecycle, 'active');
  });
  it('identical re-seen long descriptions do not false-positive', () => {
    const store = emptyStore();
    const long = `Role. ${'x '.repeat(3000)}`;
    upsertJobs(store, [{ ...BASE, source: 'dice', description: long }], NOW);
    const r = upsertJobs(store, [{ ...BASE, source: 'dice', description: long }], NOW + 1);
    assert.equal(r.unchanged, 1);
    assert.deepEqual(r.changes, []);
  });
  it('atomic persistence: roundtrip, malformed rejected, no tmp litter', () => {
    const root = tmpRoot();
    const p = join(root, 'store.json');
    const store = emptyStore();
    upsertJobs(store, [{ ...BASE, source: 'dice' }], NOW);
    saveStore(store, p);
    assert.deepEqual(loadStore(p).jobs[BASE.jobId].title, 'HR Director');
    assert.ok(!readdirSync(root).some((f) => f.includes('.tmp-')));
    writeFileSync(p, '{corrupt');
    assert.deepEqual(loadStore(p), emptyStore());
    // Backward compat: pre-lifecycle records gain defaults.
    writeFileSync(p, JSON.stringify({ jobs: { x: { jobId: 'x', title: 'T' } } }));
    const loaded = loadStore(p);
    assert.equal(loaded.jobs.x.lifecycle, 'active');
    assert.ok(loaded.jobs.x.descriptionHash);
  });
});

describe('match versioning + outcome timestamps (§13)', () => {
  it('versions persist; firstScoredVersion never rewrites', () => {
    assert.equal(MATCHER_VERSION, '1.0');
    const h = emptyHistory();
    const job = { title: 'T', company: 'C', url: 'https://x/1' };
    const r1 = recordMatch(h, { jobId: 'j', profileId: 'p', result: resultFor(80), job, profile: {} });
    assert.equal(r1.entry.scoringVersion, '1.0');
    assert.equal(r1.entry.firstScoredVersion, '1.0');
    const r2 = recordMatch(h, {
      jobId: 'j', profileId: 'p',
      result: { ...resultFor(85), scoringVersion: '2.0' }, job, profile: {},
    });
    assert.equal(r2.entry.score, 85);
    assert.equal(r2.entry.scoringVersion, '2.0');
    assert.equal(r2.entry.firstScoredVersion, '1.0'); // historical version kept
  });
  it('outcome stage timestamps: first-wins for first*, latest for outcomeAt', () => {
    const h = emptyHistory();
    const job = { title: 'T', company: 'C', url: 'https://x/1' };
    recordMatch(h, { jobId: 'j', profileId: 'p', result: resultFor(80), job, profile: {}, now: NOW });
    markViewed(h, { jobId: 'j', profileId: 'p', now: NOW + 1 });
    recordOutcome(h, { jobId: 'j', profileId: 'p', outcome: 'saved', now: NOW + 2 });
    recordOutcome(h, { jobId: 'j', profileId: 'p', outcome: 'applied', now: NOW + 3 });
    const e = h.matches['p::j'];
    assert.ok(e.firstViewedAt && e.firstSavedAt && e.appliedAt);
    assert.equal(e.outcome, 'applied');
    assert.equal(e.outcomeAt, new Date(NOW + 3).toISOString());
    assert.equal(e.interviewAt, null);
  });
  it('multi-profile change handling via getJobView (no duplication)', () => {
    const h = emptyHistory();
    const job = { title: 'T', company: 'C', url: 'https://x/1' };
    recordMatch(h, { jobId: 'j', profileId: 'a', result: resultFor(91), job, profile: {} });
    recordMatch(h, { jobId: 'j', profileId: 'b', result: resultFor(48), job, profile: {} });
    const view = getJobView(h, { jobId: 'j', profileIds: ['a', 'b', 'ghost'] });
    assert.deepEqual(Object.keys(view.profiles), ['a', 'b']);
    assert.equal(view.profiles.a.score, 91);
    assert.equal(view.profiles.b.outcome, 'surfaced');
  });
});

describe('change feed + metrics (§13)', () => {
  const store = {
    jobs: {
      n1: { jobId: 'n1', title: 'HR Director', company: 'Acme', firstSeen: NOW - HOUR(), lastSeen: NOW, lifecycle: 'active' },
      s1: { jobId: 's1', title: 'Old Role', company: 'Beta', firstSeen: NOW - 40 * DAY, lastSeen: NOW - 40 * DAY, lifecycle: 'stale' },
    },
  };
  function HOUR() { return 3600_000; }
  it('derives NEW/CHANGED/IMPROVED/STALE/MULTI from persisted state', () => {
    const history = emptyHistory();
    const job = { title: 'T', company: 'C', url: 'https://x/1' };
    recordMatch(history, { jobId: 'n1', profileId: 'a', result: resultFor(70), job, profile: {} });
    recordMatch(history, { jobId: 'n1', profileId: 'b', result: resultFor(80), job, profile: {} });
    const improved = recordMatch(history, { jobId: 'n1', profileId: 'a', result: resultFor(88), job, profile: {} });
    assert.equal(improved.entry.scoreChanged, true);
    const feed = buildChangeFeed({
      store, history,
      run: { completedAt: new Date(NOW - 2 * DAY).toISOString() },
      changes: [{ jobId: 'n1', changedFields: ['salary'] }],
      now: NOW,
    });
    const types = feed.map((i) => i.type);
    assert.ok(types.includes('NEW')); // n1 firstSeen after run
    assert.ok(types.includes('CHANGED'));
    assert.ok(types.includes('MATCH_IMPROVED'));
    assert.ok(types.includes('STALE')); // s1 stale + unacted
    assert.ok(types.includes('PROFILE_MULTI')); // 70 no; 88+80 yes
    const summary = feedSummary(feed);
    assert.equal(summary.total, feed.length);
    assert.ok(summary.new >= 1 && summary.stale >= 1);
  });
  it('measurement-only outcome metrics (no learning)', () => {
    const h = emptyHistory();
    const job = { title: 'T', company: 'C', url: 'https://x/1' };
    recordMatch(h, { jobId: 'j1', profileId: 'p', result: { ...resultFor(80), matchedSignals: ['Workday'] }, job, profile: {} });
    markViewed(h, { jobId: 'j1', profileId: 'p' });
    recordMatch(h, { jobId: 'j2', profileId: 'p', result: resultFor(40), job, profile: {} });
    const m = computeOutcomeMetrics(h);
    assert.equal(m.scored, 2);
    assert.equal(m.totals.viewed, 1);
    assert.equal(m.bySignal.workday.viewed, 1);
    assert.ok(m.conversion['surfaced→viewed'] === 0.5);
  });
});

describe('extended filters (§13)', () => {
  const aggs = [
    { jobId: 'k1', best: { score: 88 }, matches: [{ profileId: 'a', score: 88 }, { profileId: 'b', score: 80 }] },
    { jobId: 'k2', best: { score: 62 }, matches: [{ profileId: 'a', score: 62 }] },
  ];
  const jobsById = new Map([
    ['k1', { title: 'HR Director', company: 'Acme', lifecycle: 'active', firstSeen: NOW - DAY, lastChangedFields: ['salary'], sources: ['dice'] }],
    ['k2', { title: 'Janitor', company: 'Beta', lifecycle: 'stale', firstSeen: NOW - 60 * DAY, lastChangedFields: [], sources: ['linkedin'] }],
  ]);
  it('isNew/changed/highConfidence/minProfiles/lifecycle/provider', () => {
    assert.deepEqual(filterOpportunities(aggs, { isNew: true, sinceRunAt: NOW - 2 * DAY }, jobsById).map((a) => a.jobId), ['k1']);
    assert.deepEqual(filterOpportunities(aggs, { changed: true }, jobsById).map((a) => a.jobId), ['k1']);
    assert.deepEqual(filterOpportunities(aggs, { highConfidence: true }, jobsById).map((a) => a.jobId), ['k1']);
    assert.deepEqual(filterOpportunities(aggs, { minProfiles: 2 }, jobsById).map((a) => a.jobId), ['k1']);
    assert.deepEqual(filterOpportunities(aggs, { lifecycle: 'stale' }, jobsById).map((a) => a.jobId), ['k2']);
    assert.deepEqual(filterOpportunities(aggs, { provider: 'linkedin' }, jobsById).map((a) => a.jobId), ['k2']);
  });
  it('minScoreDelta uses previous scores', () => {
    const prev = new Map([['a::k1', 80], ['b::k1', 80], ['a::k2', 62]]);
    assert.deepEqual(filterOpportunities(aggs, { minScoreDelta: 5 }, jobsById, { prevScores: prev }).map((a) => a.jobId), ['k1']);
    assert.deepEqual(filterOpportunities(aggs, { minScoreDelta: 50 }, jobsById, { prevScores: prev }), []);
  });
});
