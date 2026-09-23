// verify-service tests — liveness integration, persistence, and policy.
// All provider modules are in-memory stubs: no network anywhere in this file.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyExistingJobs, verifiableSources } from '../lib/verify-service.mjs';
import {
  consecutiveNotFoundStreak,
  getVerificationCandidates,
  recordVerification,
  defaultLivenessPolicy,
} from '../lib/liveness-engine.mjs';

const stubProvider = (id, behavior, extra = {}) => ({
  id,
  async verifyJob({ job }) {
    if (typeof behavior === 'function') return behavior(job);
    if (behavior && typeof behavior === 'object') return behavior;
    return { status: behavior, evidence: { type: 'stub', provider: id, observedAt: new Date().toISOString(), confidence: 'high', reason: 'stub' } };
  },
  ...extra,
});

const rec = (id, o = {}) => ({
  jobId: id,
  title: o.title || 'Engineer',
  company: o.company || 'Acme',
  location: 'Austin, TX',
  url: o.url || `https://example.com/${id}`,
  source: o.source || 'stub-a',
  sources: o.sources || [o.source || 'stub-a'],
  postedAt: Date.now(),
  discoveredAt: Date.now(),
  firstSeen: o.firstSeen ?? Date.now(),
  lastSeen: o.lastSeen ?? Date.now(),
  seenCount: 1,
  lifecycle: o.lifecycle || 'active',
  ...(o.extra || {}),
});
const storeOf = (records) => ({ version: 1, jobs: Object.fromEntries(records.map((r) => [r.jobId, r])) });

describe('verify-service selection', () => {
  it('exposes verifiable sources only', () => {
    const mods = new Map([['stub-a', stubProvider('stub-a', 'ACTIVE')], ['plain', { id: 'plain' }]]);
    assert.deepEqual(verifiableSources(rec('k', { sources: ['stub-a', 'plain'] }), mods), ['stub-a']);
    assert.deepEqual(verifiableSources(rec('k2', { sources: ['plain'] }), mods), []);
  });

  it('never excludes saved/applied jobs by age, and enriches candidates', () => {
    const old = Date.now() - 400 * 86_400_000;
    const jobs = [
      rec('old-saved', { firstSeen: old, lastSeen: old, extra: { lastVerifiedAt: '2026-01-01T00:00:00.000Z', lifecycle: 'stale' } }),
      rec('fresh', {}),
    ];
    const histories = { matches: { 'p::old-saved': { jobId: 'old-saved', profileId: 'p', score: 50, outcome: 'saved' } } };
    const cands = getVerificationCandidates({ jobs, histories, limit: 5 });
    assert.equal(cands[0].jobId, 'old-saved');
    assert.equal(cands[0].priority, 'SAVED');
    assert.equal(cands[0].lastVerifiedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(cands[0].lifecycle, 'stale');
  });

  it('bounds selection by limit and job filter', async () => {
    const mods = new Map([['stub-a', stubProvider('stub-a', 'ACTIVE')]]);
    const store = storeOf([rec('a'), rec('b'), rec('c')]);
    const one = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, limit: 1, dryRun: true });
    assert.equal(one.selected.length, 1);
    assert.equal(one.summary.selected, 1);
    const single = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, jobId: 'b', dryRun: true });
    assert.deepEqual(single.selected.map((s) => s.jobId), ['b']);
  });
});

describe('verify-service lifecycle policy', () => {
  it('applies explicit CLOSED evidence immediately', async () => {
    const closedEvidence = {
      type: 'explicit-provider', provider: 'stub-a', confidence: 'high',
      reason: 'provider reports removal', observedAt: new Date().toISOString(),
    };
    const mods = new Map([['stub-a', stubProvider('stub-a', { status: 'CLOSED', evidence: closedEvidence })]]);
    const store = storeOf([rec('k')]);
    const out = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, dryRun: true });
    assert.equal(out.results[0].status, 'CLOSED');
    assert.equal(out.summary.closed, 1);
    const live = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, dryRun: false });
    assert.equal(live.results[0].closed, true);
    assert.equal(store.jobs.k.lifecycle, 'closed');
    assert.ok(store.jobs.k.closedEvidence);
    assert.equal(store.jobs.k.verificationHistory.length, 1);
  });

  it('unreliable NOT_FOUND never closes, even repeated', async () => {
    const mods = new Map([['stub-a', stubProvider('stub-a', 'NOT_FOUND')]]); // no reliableAbsence
    const store = storeOf([rec('k')]);
    for (let i = 0; i < 3; i++) {
      const out = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, dryRun: false });
      assert.equal(out.results[0].via, 'observation');
      assert.equal(store.jobs.k.lifecycle, 'active');
    }
    assert.equal(store.jobs.k.verificationHistory.length, 3);
    assert.equal(store.jobs.k.verificationBySource['stub-a'].status, 'NOT_FOUND');
  });

  it('reliable absence closes at the threshold (stub declares it)', async () => {
    const mods = new Map([['stub-a', stubProvider('stub-a', 'NOT_FOUND', { verify: { reliableAbsence: true } })]]);
    const store = storeOf([rec('k')]);
    const policy = { ...defaultLivenessPolicy(), closeOnRepeatedAbsence: true, absenceThreshold: 2 };
    await verifyExistingJobs({ store, providerModules: mods, ctx: {}, policy, dryRun: false });
    assert.equal(store.jobs.k.lifecycle, 'active');
    const second = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, policy, dryRun: false });
    assert.equal(second.results[0].via, 'repeated-absence');
    assert.equal(store.jobs.k.lifecycle, 'closed');
  });

  it('provider failure never closes and is recorded', async () => {
    for (const status of ['BLOCKED', 'RATE_LIMITED', 'TEMPORARILY_UNAVAILABLE', 'ERROR', 'UNKNOWN']) {
      const mods = new Map([['stub-a', stubProvider('stub-a', status)]]);
      const store = storeOf([rec('k')]);
      const out = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, dryRun: false });
      assert.equal(store.jobs.k.lifecycle, 'active', status);
      assert.equal(out.results[0].closed, false, status);
      assert.equal(store.jobs.k.verificationHistory[0].status, status);
    }
  });
  it('multi-source observations stay source-specific', async () => {
    const mods = new Map([
      ['stub-a', stubProvider('stub-a', 'ACTIVE')],
      ['stub-b', stubProvider('stub-b', 'BLOCKED')],
    ]);
    const store = storeOf([rec('k', { sources: ['stub-a', 'stub-b'] })]);
    const out = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, dryRun: false });
    assert.equal(out.results.length, 2);
    assert.equal(store.jobs.k.lifecycle, 'active');
    assert.equal(store.jobs.k.verificationBySource['stub-a'].status, 'ACTIVE');
    assert.equal(store.jobs.k.verificationBySource['stub-b'].status, 'BLOCKED');
  });

  it('§4: B BLOCKED is never evidence that A closed (dice ACTIVE + greenhouse BLOCKED)', async () => {
    const mods = new Map([
      ['dice', stubProvider('dice', 'ACTIVE')],
      ['greenhouse', stubProvider('greenhouse', 'BLOCKED')],
    ]);
    const store = storeOf([rec('k', { source: 'dice', sources: ['dice', 'greenhouse'] })]);
    const out = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, dryRun: false });
    const byProvider = Object.fromEntries(out.results.map((r) => [r.provider, r.status]));
    assert.deepEqual(byProvider, { dice: 'ACTIVE', greenhouse: 'BLOCKED' });
    // Deterministic lifecycle: ACTIVE observation present, failure never closes.
    assert.equal(store.jobs.k.lifecycle, 'active');
    assert.equal(store.jobs.k.closedEvidence, undefined);
    // Neither source's evidence touched the other's slot.
    assert.equal(store.jobs.k.verificationBySource.dice.status, 'ACTIVE');
    assert.equal(store.jobs.k.verificationBySource.greenhouse.status, 'BLOCKED');
    assert.equal(store.jobs.k.verificationHistory.length, 2);
  });

  it('dry-run performs no writes', async () => {
    const mods = new Map([['stub-a', stubProvider('stub-a', 'ACTIVE')]]);
    const store = storeOf([rec('k')]);
    const before = JSON.stringify(store);
    const out = await verifyExistingJobs({ store, providerModules: mods, ctx: {}, dryRun: true });
    assert.equal(out.dryRun, true);
    assert.equal(out.persisted, false);
    assert.equal(JSON.stringify(store), before);
  });
});

describe('verify-service persistence', () => {
  it('bounds verification history to maxHistory', () => {
    const store = storeOf([rec('k')]);
    for (let i = 0; i < 15; i++) {
      recordVerification(store, 'k', { provider: 'stub-a', status: 'ACTIVE', checkedAt: new Date().toISOString() }, { policy: { ...defaultLivenessPolicy(), maxHistory: 10 } });
    }
    assert.equal(store.jobs.k.verificationHistory.length, 10);
  });

  it('persists compact evidence with the entry', () => {
    const store = storeOf([rec('k')]);
    recordVerification(store, 'k', {
      provider: 'stub-a',
      status: 'ACTIVE',
      evidence: { type: 'detail_page_active', provider: 'stub-a', source: 'u', observedAt: 't', confidence: 'high', reason: 'r', pageTitle: 'T', extra: 'dropped', html: '<div>dropped</div>' },
    }, {});
    const e = store.jobs.k.verificationHistory[0].evidence;
    assert.equal(e.type, 'detail_page_active');
    assert.ok(!('extra' in e) && !('html' in e));
  });

  it('streak counts the trailing per-source NOT_FOUND run, skipping other providers', () => {
    const record = rec('k', {
      extra: {
        verificationHistory: [
          { provider: 'stub-a', status: 'NOT_FOUND' },
          { provider: 'stub-b', status: 'ACTIVE' },
          { provider: 'stub-a', status: 'NOT_FOUND' },
          { provider: 'stub-a', status: 'NOT_FOUND' },
        ],
      },
    });
    assert.equal(consecutiveNotFoundStreak(record, 'stub-a'), 3);
    assert.equal(consecutiveNotFoundStreak(record, 'stub-b'), 0);
    assert.equal(consecutiveNotFoundStreak(rec('x'), 'stub-a'), 0);
    // Same-provider non-NOT_FOUND breaks the run.
    const broken = rec('k', {
      extra: { verificationHistory: [{ provider: 'stub-a', status: 'NOT_FOUND' }, { provider: 'stub-a', status: 'ACTIVE' }, { provider: 'stub-a', status: 'NOT_FOUND' }] },
    });
    assert.equal(consecutiveNotFoundStreak(broken, 'stub-a'), 1);
  });

  it('miss on unknown job applies nothing', () => {
    const store = storeOf([rec('k')]);
    const out = recordVerification(store, 'nope', { provider: 's', status: 'ACTIVE' }, {});
    assert.equal(out.applied, false);
  });
});
