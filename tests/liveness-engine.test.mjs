import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultLivenessPolicy, validatePolicy, verifyJob, verifyJobs,
  getVerificationCandidates, recordVerification, evaluateAbsence,
  isFailureStatus, VERIFY_STATUSES,
} from '../lib/liveness-engine.mjs';
import { emptyStore } from '../lib/job-store.mjs';

const NOW = Date.now();
const DAY = 86_400_000;

function mockProvider(id, impl = {}) {
  return { id, detect: () => null, fetch: async () => [], ...impl };
}

describe('liveness policy (§4)', () => {
  it('defaults keep 30/120-day thresholds', () => {
    const p = defaultLivenessPolicy();
    assert.equal(p.staleAfterDays, 30);
    assert.equal(p.closedAfterDays, 120);
    assert.equal(p.closeOnRepeatedAbsence, false);
  });
  it('rejects nonsense thresholds', () => {
    assert.throws(() => validatePolicy({ staleAfterDays: -1 }), /staleAfterDays/);
    assert.throws(() => validatePolicy({ staleAfterDays: 200, closedAfterDays: 30 }), /must not exceed/);
    assert.throws(() => validatePolicy({ concurrency: 99 }), /concurrency/);
    const p = validatePolicy({ staleAfterDays: 7 });
    assert.equal(p.staleAfterDays, 7);
    assert.equal(p.closedAfterDays, 120);
  });
});

describe('verifyJob contract (§2–3)', () => {
  const job = { jobId: 'k1', title: 'T', url: 'https://j/1' };
  it('ACTIVE on positive proof, CLOSED on provider-reported removal', async () => {
    const mods = new Map([
      ['up', mockProvider('up', { verifyJob: async () => ({ status: 'ACTIVE' }) })],
      ['gone', mockProvider('gone', { verifyJob: async () => ({ status: 'CLOSED', evidence: { reason: 'removed' } }) })],
    ]);
    assert.equal((await verifyJob({ job, source: 'up', providerModules: mods, now: NOW })).status, 'ACTIVE');
    assert.equal((await verifyJob({ job, source: 'gone', providerModules: mods, now: NOW })).status, 'CLOSED');
  });
  it('NOT_FOUND is an observation, never auto-closure', async () => {
    const mods = new Map([['nf', mockProvider('nf', { verifyJob: async () => ({ status: 'NOT_FOUND' }) })]]);
    const r = await verifyJob({ job, source: 'nf', providerModules: mods, now: NOW });
    assert.equal(r.status, 'NOT_FOUND');
    assert.ok(typeof r.checkedAt === 'string' && typeof r.runtimeMs === 'number');
  });
  it('no hook, unknown provider, and unknown statuses → UNKNOWN', async () => {
    const mods = new Map([
      ['plain', mockProvider('plain')],
      ['weird', mockProvider('weird', { verifyJob: async () => ({ status: 'MAYBE' }) })],
    ]);
    assert.equal((await verifyJob({ job, source: 'plain', providerModules: mods, now: NOW })).status, 'UNKNOWN');
    assert.equal((await verifyJob({ job, source: 'ghost', providerModules: mods, now: NOW })).status, 'UNKNOWN');
    assert.equal((await verifyJob({ job, source: 'weird', providerModules: mods, now: NOW })).status, 'UNKNOWN');
  });
  it('failures map to failure statuses — never CLOSED', async () => {
    const noSleep = { sleep: async () => {} };
    const boom = (status, body = '') => {
      const e = new Error('nope');
      if (status) { e.status = status; e.body = body; }
      return e;
    };
    const mods = new Map([
      ['blocked', mockProvider('blocked', { verifyJob: async () => { throw boom(403); } })],
      ['auth', mockProvider('auth', { verifyJob: async () => { throw boom(401); } })],
      ['net', mockProvider('net', { verifyJob: async () => { throw new TypeError('socket hang up'); } })],
      ['unsup', mockProvider('unsup', { verifyJob: async () => { const e = new Error('no'); e.providerErrorType = 'UNSUPPORTED'; throw e; } })],
    ]);
    // provider-result classifyProviderError paths: exercise via thrown generic errors
    assert.equal((await verifyJob({ job, source: 'blocked', providerModules: mods, now: NOW })).status, 'BLOCKED');
    assert.equal((await verifyJob({ job, source: 'auth', providerModules: mods, now: NOW })).status, 'AUTH_REQUIRED');
    const net = await verifyJob({ job, source: 'net', providerModules: mods, ctx: noSleep, now: NOW });
    assert.equal(net.status, 'ERROR');
    assert.equal((await verifyJob({ job, source: 'unsup', providerModules: mods, ctx: noSleep, now: NOW })).status, 'UNSUPPORTED');
    for (const s of ['BLOCKED', 'AUTH_REQUIRED', 'ERROR', 'UNSUPPORTED']) assert.ok(isFailureStatus(s));
    assert.ok(!isFailureStatus('ACTIVE') && !isFailureStatus('CLOSED'));
  });
  it('RATE_LIMITED retries then surfaces, errors carry runtime', async () => {
    let n = 0;
    const mods = new Map([['flaky', mockProvider('flaky', {
      verifyJob: async () => { n++; if (n < 3) { const e = new Error('slow'); e.status = 429; throw e; } return { status: 'ACTIVE' }; },
    })]]);
    const r = await verifyJob({ job, source: 'flaky', providerModules: mods, ctx: { sleep: async () => {} }, policy: { ...defaultLivenessPolicy(), maxAttempts: 3 }, now: NOW });
    assert.equal(r.status, 'ACTIVE');
    assert.equal(n, 3);
  });
  it('verifyJobs batches with bounded concurrency', async () => {
    const mods = new Map([['up', mockProvider('up', { verifyJob: async () => ({ status: 'ACTIVE' }) })]]);
    const jobs = Array.from({ length: 6 }, (_, i) => ({ jobId: `k${i}`, url: `https://j/${i}` }));
    const out = await verifyJobs({ jobs, sourceOf: () => 'up', providerModules: mods, now: NOW });
    assert.equal(out.length, 6);
    assert.ok(out.every((r) => r.status === 'ACTIVE' && r.jobId));
  });
});

describe('verification candidates (§6, §17)', () => {
  const jobs = [
    { jobId: 'saved-one', lastSeen: NOW - DAY, lastChangedFields: [] },
    { jobId: 'hot-one', lastSeen: NOW - DAY, lastChangedFields: [] },
    { jobId: 'changed-one', lastSeen: NOW - DAY, lastChangedFields: ['salary'] },
    { jobId: 'stale-one', lastSeen: NOW - 29 * DAY, lastChangedFields: [] },
    { jobId: 'old-one', lastSeen: NOW - 60 * DAY, lastChangedFields: [] },
  ];
  const histories = { matches: {
    'a::saved-one': { jobId: 'saved-one', profileId: 'a', score: 60, outcome: 'saved' },
    'a::hot-one': { jobId: 'hot-one', profileId: 'a', score: 90, outcome: 'surfaced' },
  } };
  it('priority order with visible reasons, deterministic', () => {
    const c = getVerificationCandidates({ jobs, histories, limit: 10, now: NOW });
    const order = c.map((x) => x.jobId);
    assert.deepEqual(order.slice(0, 3), ['saved-one', 'hot-one', 'changed-one']);
    assert.ok(order.indexOf('stale-one') > 2 && order.indexOf('old-one') > 2);
    assert.ok(c.every((x) => typeof x.reason === 'string' && x.reason.length > 0));
    assert.equal(c[0].priority, 'SAVED');
    assert.equal(c[1].priority, 'HIGH_SCORE');
    assert.equal(c[2].priority, 'CHANGED');
    assert.equal(c[3].priority, 'APPROACHING_STALE');
    // Deterministic rerun.
    assert.deepEqual(getVerificationCandidates({ jobs, histories, limit: 10, now: NOW }).map((x) => x.jobId), order);
    assert.equal(getVerificationCandidates({ jobs, histories, limit: 2, now: NOW }).length, 2);
  });
});

describe('recordVerification (§5: bounded, history-safe)', () => {
  it('appends history, stamps lastVerifiedAt, closes only on valid evidence', () => {
    const store = emptyStore();
    store.jobs.k1 = { jobId: 'k1', title: 'T', lifecycle: 'active', lastSeen: NOW };
    const r1 = recordVerification(store, 'k1', { provider: 'dice', status: 'ACTIVE', checkedAt: new Date(NOW).toISOString(), runtimeMs: 5 }, { now: NOW });
    assert.deepEqual([r1.applied, r1.closed], [true, false]);
    assert.equal(store.jobs.k1.verificationHistory.length, 1);
    assert.equal(store.jobs.k1.lifecycle, 'active');
    // Invalid evidence never closes.
    const r2 = recordVerification(store, 'k1', { provider: 'dice', status: 'CLOSED', evidence: { bad: 1 }, checkedAt: new Date(NOW).toISOString() }, { now: NOW });
    assert.deepEqual([r2.applied, r2.closed], [true, false]);
    assert.equal(store.jobs.k1.lifecycle, 'active');
    // Valid evidence closes with trail, keeping the record.
    const r3 = recordVerification(store, 'k1', {
      provider: 'dice', status: 'CLOSED',
      evidence: { type: 'explicit-provider', provider: 'dice', confidence: 'high', reason: 'detail 404', observedAt: new Date(NOW).toISOString() },
      checkedAt: new Date(NOW).toISOString(),
    }, { now: NOW });
    assert.deepEqual([r3.applied, r3.closed], [true, true]);
    assert.equal(store.jobs.k1.lifecycle, 'closed');
    assert.equal(store.jobs.k1.title, 'T'); // record intact
    assert.equal(recordVerification(store, 'ghost', { status: 'ACTIVE' }, {}).applied, false);
  });
  it('history is bounded by policy', () => {
    const store = emptyStore();
    store.jobs.k1 = { jobId: 'k1', lifecycle: 'active', lastSeen: NOW };
    for (let i = 0; i < 15; i++) {
      recordVerification(store, 'k1', { provider: 'd', status: 'ACTIVE', checkedAt: new Date(NOW + i).toISOString() }, { policy: { ...defaultLivenessPolicy(), maxHistory: 5 }, now: NOW });
    }
    assert.equal(store.jobs.k1.verificationHistory.length, 5);
  });
});

describe('absence evaluation (§3)', () => {
  it('defaults never auto-close; reliable+threshold closes with evidence', () => {
    const p = defaultLivenessPolicy();
    assert.deepEqual(evaluateAbsence({ jobId: 'k', provider: { id: 'd' }, consecutiveNotFounds: 99, policy: p }).close, false);
    const rel = { id: 'd', verify: { reliableAbsence: true } };
    assert.equal(evaluateAbsence({ jobId: 'k', provider: rel, consecutiveNotFounds: 2, policy: p }).close, false);
    const optIn = { ...p, closeOnRepeatedAbsence: true };
    assert.equal(evaluateAbsence({ jobId: 'k', provider: rel, consecutiveNotFounds: 2, policy: optIn }).close, false);
    const yes = evaluateAbsence({ jobId: 'k', provider: rel, consecutiveNotFounds: 3, policy: optIn });
    assert.equal(yes.close, true);
    assert.equal(yes.evidence.type, 'explicit-provider');
    assert.ok(VERIFY_STATUSES.includes('NOT_FOUND'));
  });
});
