import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonRepository } from '../lib/repositories/json-file.mjs';
import { openJobRepository } from '../lib/repositories/job-repository.mjs';
import { openMatchRepository } from '../lib/repositories/match-repository.mjs';
import { openProfileRepository } from '../lib/repositories/profile-repository.mjs';
import { openDiscoveryRunRepository } from '../lib/repositories/discovery-run-repository.mjs';
import { openOutcomeRepository } from '../lib/repositories/outcome-repository.mjs';

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'scav-repo-'));
const JOB = { title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://j/1', source: 'dice', postedAt: Date.now() };

describe('repositories: persistence (§2–3, §20)', () => {
  it('json-file: strict reads reject malformed state; writes leave no tmp litter', () => {
    const root = tmpRoot();
    const p = join(root, 'x.json');
    const repo = createJsonRepository(p, () => ({ v: 0 }), (parsed) => (typeof parsed.v === 'number' ? parsed : null));
    assert.deepEqual(repo.load(), { v: 0 }); // missing → empty
    repo.save({ v: 3 });
    assert.deepEqual(repo.load(), { v: 3 });
    assert.ok(!readdirSync(root).some((f) => f.includes('.tmp-')));
    writeFileSync(p, '{broken');
    assert.deepEqual(repo.load(), { v: 0 }); // malformed → empty, never merged
    writeFileSync(p, JSON.stringify([1, 2]));
    assert.deepEqual(repo.load(), { v: 0 }); // normalize rejects arrays
    writeFileSync(p, JSON.stringify({ v: 9, extra: true }));
    assert.deepEqual(repo.load(), { v: 9, extra: true }); // valid passes through
  });

  it('job repository: CRUD + duplicate prevention + backward compat', () => {
    const root = tmpRoot();
    const jobs = openJobRepository(join(root, 'jobs.json'));
    assert.equal(jobs.count(), 0);
    const r1 = jobs.upsert([{ ...JOB }], Date.now());
    assert.deepEqual([r1.added, r1.updated], [1, 0]);
    assert.equal(jobs.count(), 1);
    const id = Object.keys(jobs.load().jobs)[0];
    assert.ok(jobs.get(id).title === 'HR Director');
    assert.equal(jobs.get('missing'), null);
    const r2 = jobs.upsert([{ ...JOB }], Date.now() + 1);
    assert.equal(r2.added, 0); // no duplicate
    // Backward compat: pre-lifecycle record gains defaults on load.
    writeFileSync(join(root, 'legacy.json'), JSON.stringify({ jobs: { k: { jobId: 'k', title: 'T' } } }));
    const legacy = openJobRepository(join(root, 'legacy.json'));
    assert.equal(legacy.get('k').lifecycle, 'active');
    assert.ok(legacy.get('k').descriptionHash);
  });

  it('match repository: userId seam isolates tenants', () => {
    const root = tmpRoot();
    const a = openMatchRepository(join(root, 'h.json'), 'local');
    const other = openMatchRepository(join(root, 'h.json'), 'user-b');
    const res = { score: 80, band: 'review', reasons: [], penalties: [], matchedSignals: [], missingSignals: [] };
    a.record({ jobId: 'j', profileId: 'p', result: res, job: {}, profile: {} });
    assert.equal(a.getMatches({}).length, 1);
    assert.equal(other.getMatches({}).length, 0); // tenant isolation
    assert.equal(other.getOutcome({ profileId: 'p', jobId: 'j' }), null);
    assert.ok(a.getOutcome({ profileId: 'p', jobId: 'j' }));
    assert.equal(a.outcome({ jobId: 'j', profileId: 'p', outcome: 'saved' }).ok, true);
    assert.equal(other.outcome({ jobId: 'j', profileId: 'p', outcome: 'saved' }).ok, false); // no cross-tenant write (no match recorded)
  });

  it('profile repository: CRUD + cross-user misses', () => {
    const root = tmpRoot();
    const path = join(root, 'ws.json');
    const mine = openProfileRepository(path, 'local');
    const rec = mine.create({ name: 'HR', profile: { targetRoles: ['HR Director'] } });
    assert.ok(rec.id && rec.userId === 'local');
    assert.equal(mine.list().length, 1);
    assert.equal(mine.get(rec.id).name, 'HR');
    const stranger = openProfileRepository(path, 'user-b');
    assert.equal(stranger.list().length, 0);
    assert.equal(stranger.get(rec.id), null);
    assert.equal(stranger.update(rec.id, { name: 'X' }), null);
    assert.equal(stranger.remove(rec.id), false);
    const copy = mine.duplicate(rec.id);
    assert.ok(copy.id !== rec.id && copy.userId === 'local');
    assert.deepEqual(mine.select([rec.id, 'ghost']), [rec.id]);
    assert.equal(mine.remove(rec.id), true);
  });

  it('discovery-run repository: append cap + consecutive COMPLETE pairs', () => {
    const root = tmpRoot();
    const runs = openDiscoveryRunRepository(join(root, 'runs.json'));
    assert.deepEqual(runs.load(), { runs: [] });
    runs.append({ runId: 'r1', status: 'COMPLETE', observedJobIds: ['a', 'b'] });
    runs.append({ runId: 'r2', status: 'PARTIAL', observedJobIds: ['a'] });
    runs.append({ runId: 'r3', status: 'COMPLETE', observedJobIds: ['b', 'c'] });
    runs.append({ runId: 'r4', status: 'FAILED', observedJobIds: [] });
    assert.equal(runs.latest().runId, 'r3'); // skips PARTIAL/FAILED
    assert.equal(runs.latest('FAILED').runId, 'r4');
    const { previous, current } = runs.consecutiveComplete();
    assert.equal(previous.runId, 'r1');
    assert.equal(current.runId, 'r3');
    assert.deepEqual(runs.recent(2).map((r) => r.runId), ['r4', 'r3']);
    // Cap: private helper keeps 50; simulate by appending (spot-check length bound logic)
    const many = openDiscoveryRunRepository(join(root, 'many.json'));
    for (let i = 0; i < 60; i++) many.append({ runId: `x${i}`, status: 'COMPLETE' });
    assert.equal(many.load().runs.length, 50);
  });

  it('outcome repository: read-only measurement over history', () => {
    const root = tmpRoot();
    const hp = join(root, 'h.json');
    const matches = openMatchRepository(hp);
    const res = (score, signals) => ({
      score, band: score >= 75 ? 'strong' : 'weak', reasons: [], penalties: [],
      matchedSignals: signals, missingSignals: [],
    });
    matches.record({ jobId: 'j1', profileId: 'a', result: res(90, ['Workday']), job: {}, profile: {} });
    matches.record({ jobId: 'j1', profileId: 'b', result: res(50, ['Workday']), job: {}, profile: {} });
    matches.outcome({ jobId: 'j1', profileId: 'a', outcome: 'saved' });
    const out = openOutcomeRepository(hp, {});
    const m = out.metrics();
    assert.equal(m.scored, 2);
    assert.equal(m.totals.saved, 1);
    assert.ok(out.bandMatrix().strong.saved === 1);
    assert.ok(out.signalTable().some((r) => r.signal === 'workday' && r.samples === 2));
    assert.deepEqual(out.profileCounts(), { jobs: 1, byProfileCount: { 2: 1 } });
    assert.equal(out.highScoreRejections().length, 0);
  });
});
