import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyStore, upsertJobs, allJobs } from '../lib/job-store.mjs';
import { refreshLifecycle } from '../lib/job-diff.mjs';
import { matchPool } from '../lib/matcher.mjs';
import { buildChangeFeed } from '../lib/change-feed.mjs';
import { emptyHistory, recordMatch } from '../lib/match-history.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { openJobRepository } from '../lib/repositories/job-repository.mjs';

function makeJobs(n, now) {
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push({
      title: `${i % 2 ? 'Senior' : ''} Engineer ${i}`.trim(),
      company: `Company${i % 60}`, location: 'Austin, TX',
      url: `https://jobs.test/${i}`, source: 'dice',
      postedAt: now - (i % 40) * 86_400_000,
      description: `Build systems with Python and teamwork ${i}`,
    });
  }
  return jobs;
}

function makeProfiles() {
  return [
    { id: 'a', profile: normalizeCareerProfile({ targetRoles: ['Engineer'], seniority: 'senior', skills: ['Python'] }) },
    { id: 'b', profile: normalizeCareerProfile({ targetRoles: ['Manager'], seniority: 'director', skills: ['teamwork'] }) },
    { id: 'c', profile: normalizeCareerProfile({ targetRoles: ['Designer'], seniority: 'mid' }) },
    { id: 'd', profile: normalizeCareerProfile({ targetRoles: ['Analyst'], seniority: 'entry' }) },
  ];
}

// Phase 6 §14: intelligence work is local + deterministic. No provider calls
// exist anywhere in this file — if matching or diffing ever needs the
// network, this suite cannot pass without timing out the budget below.
describe('intel performance (local, deterministic)', () => {
  it('500 stored jobs: lifecycle + 4-profile matching + feed in budget', () => {
    const store = emptyStore();
    const jobs = [];
    for (let i = 0; i < 500; i++) {
      jobs.push({
        title: `${i % 2 ? 'Senior' : ''} Engineer ${i}`.trim(),
        company: `Company${i % 60}`, location: 'Austin, TX',
        url: `https://jobs.test/${i}`, source: 'dice',
        postedAt: Date.now() - (i % 40) * 86_400_000,
        description: `Build systems with Python and teamwork ${i}`,
      });
    }
    const profiles = [
      { id: 'a', profile: normalizeCareerProfile({ targetRoles: ['Engineer'], seniority: 'senior', skills: ['Python'] }) },
      { id: 'b', profile: normalizeCareerProfile({ targetRoles: ['Manager'], seniority: 'director', skills: ['teamwork'] }) },
      { id: 'c', profile: normalizeCareerProfile({ targetRoles: ['Designer'], seniority: 'mid' }) },
      { id: 'd', profile: normalizeCareerProfile({ targetRoles: ['Analyst'], seniority: 'entry' }) },
    ];
    const t0 = Date.now();
    const up = upsertJobs(store, jobs, Date.now());
    const tUpsert = Date.now() - t0;
    assert.equal(up.added, 500);
    const t1 = Date.now();
    refreshLifecycle(store, {});
    const tLifecycle = Date.now() - t1;
    const t2 = Date.now();
    const pool = matchPool(allJobs(store), profiles);
    const tMatch = Date.now() - t2;
    assert.equal(pool.length, 500);
    const history = emptyHistory();
    pool.slice(0, 50).forEach((agg, i) => recordMatch(history, {
      jobId: agg.jobId, profileId: 'a', result: agg.matches[0], job: {}, profile: {},
    }));
    const t3 = Date.now();
    const feed = buildChangeFeed({ store, history, run: null, changes: [], now: Date.now() });
    const tFeed = Date.now() - t3;
    assert.ok(feed.length >= 0);
    console.log(`      intel perf: upsert ${tUpsert}ms, lifecycle ${tLifecycle}ms, match(500×4) ${tMatch}ms, feed ${tFeed}ms`);
    assert.ok(tUpsert + tLifecycle + tMatch + tFeed < 30000, 'intelligence budget exceeded');
  });

  // Phase 7 §19: repository read/write + diff + feed at 1k/5k/10k canonical
  // jobs. Determines where JSON persistence starts becoming expensive —
  // measured, not speculated.
  for (const n of [1000, 5000, 10000]) {
    it(`repository scale: ${n} canonical jobs read/write/diff/feed`, () => {
      const root = mkdtempSync(join(tmpdir(), 'scav-perf-'));
      const repo = openJobRepository(join(root, 'job-store.json'));
      const now = Date.now();
      const jobs = makeJobs(n, now);
      const profiles = makeProfiles();
      let t = Date.now();
      const up = repo.upsert(jobs, now);
      const tUpsert = Date.now() - t;
      assert.equal(up.added, n);
      t = Date.now();
      const reloaded = repo.load();
      const tRead = Date.now() - t;
      assert.equal(Object.keys(reloaded.jobs).length, n);
      t = Date.now();
      const lc = repo.refreshLifecycle({ now });
      const tLifecycle = Date.now() - t;
      assert.equal(lc.active + lc.stale + lc.closed, n);
      t = Date.now();
      const pool = matchPool(Object.values(reloaded.jobs), profiles);
      const tMatch = Date.now() - t;
      assert.equal(pool.length, n);
      t = Date.now();
      const feed = buildChangeFeed({ store: reloaded, history: emptyHistory(), run: null, changes: [], now });
      const tFeed = Date.now() - t;
      console.log(`      scale ${n}: upsert+write ${tUpsert}ms, read ${tRead}ms, lifecycle ${tLifecycle}ms, match(×4) ${tMatch}ms, feed ${tFeed}ms`);
      assert.ok(tUpsert + tRead + tLifecycle + tMatch + tFeed < 120000, `scale budget exceeded at ${n}`);
    });
  }

  // Phase 8 §23: async run CRUD/reads, liveness selection at scale, 10k diff,
  // run-history reads. All local; no provider calls anywhere in this file.
  it('async run creation + status reads stay cheap', async () => {
    const { openAsyncRunRepository } = await import('../lib/repositories/async-run-repository.mjs');
    const root = mkdtempSync(join(tmpdir(), 'scav-perf-runs-'));
    const repos = openAsyncRunRepository(root);
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      repos.create({ runId: `r${i}`, profiles: [{ id: 'a', name: 'A' }], options: {} });
    }
    const tCreate = Date.now() - t0;
    const t1 = Date.now();
    for (let i = 0; i < 200; i++) repos.get(`r${i % 200}`);
    const tRead = Date.now() - t1;
    const t2 = Date.now();
    repos.list(20);
    repos.recover(Date.now());
    const tList = Date.now() - t2;
    console.log(`      async runs: 200×create ${tCreate}ms, 200×status-read ${tRead}ms, list+recover ${tList}ms`);
    assert.ok(tCreate + tRead + tList < 30000, 'run-store budget exceeded');
  });

  it('liveness selection at 1k/10k + 10k diff stay in budget', async () => {
    const { getVerificationCandidates } = await import('../lib/liveness-engine.mjs');
    const { diffConsecutiveRuns } = await import('../lib/job-liveness.mjs');
    for (const n of [1000, 10000]) {
      const now = Date.now();
      const jobs = [];
      for (let i = 0; i < n; i++) {
        jobs.push({
          jobId: `k${i}`, lastSeen: now - (i % 50) * 86_400_000,
          lastChangedFields: i % 7 === 0 ? ['salary'] : [],
        });
      }
      const histories = { matches: {} };
      for (let i = 0; i < Math.min(n, 200); i++) {
        histories.matches[`a::k${i * 3}`] = { jobId: `k${i * 3}`, profileId: 'a', score: 80 + (i % 15), outcome: i % 9 === 0 ? 'saved' : 'surfaced' };
      }
      const t0 = Date.now();
      const cands = getVerificationCandidates({ jobs, histories, limit: 100, now });
      const tSelect = Date.now() - t0;
      assert.equal(cands.length, 100);
      const t1 = Date.now();
      const ids = jobs.map((j) => j.jobId);
      const diff = diffConsecutiveRuns(
        { status: 'COMPLETE', observedJobIds: ids.slice(0, n - 100) },
        { status: 'COMPLETE', observedJobIds: ids.slice(50) },
      );
      const tDiff = Date.now() - t1;
      assert.equal(diff.new.length, 100);
      assert.equal(diff.missing.length, 50);
      console.log(`      liveness ${n}: selection ${tSelect}ms, 10k-diff ${tDiff}ms`);
      assert.ok(tSelect + tDiff < 30000, `liveness budget exceeded at ${n}`);
    }
  });

  it('run-history reads at 50-run cap stay cheap', async () => {
    const { openDiscoveryRunRepository } = await import('../lib/repositories/discovery-run-repository.mjs');
    const root = mkdtempSync(join(tmpdir(), 'scav-perf-hist-'));
    const repos = openDiscoveryRunRepository(join(root, 'runs.json'));
    for (let i = 0; i < 50; i++) {
      repos.append({ runId: `r${i}`, status: i % 3 ? 'COMPLETE' : 'PARTIAL', observedJobIds: ['a', 'b'] });
    }
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) {
      repos.recent(10);
      repos.consecutiveComplete();
    }
    const tRead = Date.now() - t0;
    console.log(`      run history: 100 reads ${tRead}ms`);
    assert.ok(tRead < 10000, 'run-history budget exceeded');
  });
});
