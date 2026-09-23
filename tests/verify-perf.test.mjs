// Verification + search-quality performance (local, deterministic).
// Budgets are generous upper bounds against regressions, not targets.
// No provider network anywhere: stub modules resolve immediately.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyExistingJobs } from '../lib/verify-service.mjs';
import { getVerificationCandidates, recordVerification } from '../lib/liveness-engine.mjs';
import { computeSearchQuality } from '../lib/search-quality.mjs';

const stub = {
  id: 'stub',
  async verifyJob() {
    return { status: 'ACTIVE', evidence: { type: 'stub', provider: 'stub', observedAt: new Date(0).toISOString(), confidence: 'high', reason: 'perf' } };
  },
};
const mods = new Map([['stub', stub]]);
const ctx = {};

const mkRecords = (n, withHistory = false) => {
  const jobs = {};
  for (let i = 0; i < n; i++) {
    const id = `k${String(i).padStart(5, '0')}`;
    jobs[id] = {
      jobId: id, title: 'Engineer', company: `Acme${i % 50}`, location: 'Austin, TX',
      url: `https://example.com/${id}`, source: 'stub', sources: ['stub'],
      postedAt: Date.now(), discoveredAt: Date.now(), firstSeen: Date.now() - (i % 40) * 86_400_000,
      lastSeen: Date.now() - (i % 40) * 86_400_000, seenCount: 2, lifecycle: 'active',
      sourceQueryFamilies: { stub: { '(q)': i % 2 ? 'exact' : 'broader' } },
    };
    if (withHistory) {
      jobs[id].verificationHistory = [];
      for (let v = 0; v < 10; v++) {
        jobs[id].verificationHistory.push({ provider: 'stub', status: 'ACTIVE', checkedAt: new Date(0).toISOString(), runtimeMs: 1 });
      }
      jobs[id].lastVerifiedAt = new Date(0).toISOString();
    }
  }
  return { version: 1, jobs };
};

describe('verify + quality performance (local)', () => {
  it('25-job verification pass stays in budget', async () => {
    const store = mkRecords(25);
    const t0 = Date.now();
    const out = await verifyExistingJobs({ store, providerModules: mods, ctx, limit: 25, dryRun: false });
    const dt = Date.now() - t0;
    assert.equal(out.summary.verified, 25);
    console.log(`      25-job verify pass: ${dt}ms`);
    assert.ok(dt < 15000, 'verify budget exceeded');
  });

  it('candidate selection at 100 and 1k stays in budget', async () => {
    for (const n of [100, 1000]) {
      const store = mkRecords(n, true);
      const jobs = Object.values(store.jobs);
      const t0 = Date.now();
      const cands = getVerificationCandidates({ jobs, histories: {}, limit: 100 });
      const dt = Date.now() - t0;
      assert.equal(cands.length, 100);
      console.log(`      selection ${n}: ${dt}ms`);
      assert.ok(dt < 10000, `selection budget exceeded at ${n}`);
    }
  });

  it('search-quality aggregation at 1k and 10k stays in budget', async () => {
    for (const n of [1000, 10000]) {
      const store = mkRecords(n);
      const records = Object.values(store.jobs);
      const historyEntries = records.slice(0, Math.min(n, 2000)).map((r, i) => ({
        jobId: r.jobId, profileId: `p${i % 3}`, score: 60 + (i % 40),
        band: i % 2 ? 'strong' : 'review', outcome: i % 7 === 0 ? 'saved' : 'surfaced',
        viewed: i % 3 === 0,
      }));
      const runs = [{
        runId: 'r1', status: 'COMPLETE', selectedProfileIds: ['p0', 'p1', 'p2'],
        providersRequested: ['stub'], providerHealth: { stub: 'ACTIVE' },
        rawCounts: { stub: n }, normalizedCounts: { stub: n }, usAcceptedCounts: { stub: n },
        freshCounts: { stub: n }, duplicateCounts: { stub: 0 },
        canonicalAddedByProvider: { stub: n }, canonicalUpdatedByProvider: { stub: 0 },
        queryStats: [
          { provider: 'stub', query: '(q)', family: 'exact', retrieved: n, normalized: n, accepted: n },
        ],
      }];
      const t0 = Date.now();
      const q = computeSearchQuality({ runs, records, historyEntries });
      const dt = Date.now() - t0;
      assert.equal(q.byProvider.stub.retrieved, n);
      console.log(`      quality ${n}: ${dt}ms`);
      assert.ok(dt < 30000, `quality budget exceeded at ${n}`);
    }
  });

  it('verification-history reads stay cheap', async () => {
    const store = mkRecords(500, true);
    const jobs = Object.values(store.jobs);
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) getVerificationCandidates({ jobs, histories: {}, limit: 25 });
    const dt = Date.now() - t0;
    console.log(`      20× selection over 500 history-bearing records: ${dt}ms`);
    assert.ok(dt < 10000, 'history-read budget exceeded');
  });

  it('recordVerification append stays cheap', async () => {
    const store = mkRecords(200, true);
    const t0 = Date.now();
    for (const job of Object.values(store.jobs)) {
      recordVerification(store, job.jobId, { provider: 'stub', status: 'ACTIVE', checkedAt: new Date(0).toISOString() }, {});
    }
    const dt = Date.now() - t0;
    console.log(`      200× recordVerification: ${dt}ms`);
    assert.ok(dt < 5000, 'record budget exceeded');
  });

  it('second-provider verification matches single-provider pacing', async () => {
    const both = {
      id: 'stub-b',
      async verifyJob() {
        return { status: 'BLOCKED', evidence: { type: 'stub', provider: 'stub-b', observedAt: new Date(0).toISOString(), confidence: 'high', reason: 'perf' } };
      },
    };
    const mods2 = new Map([['stub', stub], ['stub-b', both]]);
    const store = { version: 1, jobs: {} };
    for (let i = 0; i < 25; i++) {
      const id = `m${i}`;
      store.jobs[id] = {
        jobId: id, title: 'E', company: 'C', url: `https://example.com/${id}`,
        source: 'stub', sources: ['stub', 'stub-b'], firstSeen: Date.now(), lastSeen: Date.now(), lifecycle: 'active',
      };
    }
    const t0 = Date.now();
    const out = await verifyExistingJobs({ store, providerModules: mods2, ctx, limit: 25, dryRun: false });
    const dt = Date.now() - t0;
    assert.equal(out.summary.verified, 50); // 25 jobs × 2 sources
    console.log(`      25-job × 2-source verify pass: ${dt}ms`);
    assert.ok(dt < 15000, 'multi-source verify budget exceeded');
  });
});
