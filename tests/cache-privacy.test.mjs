import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSuccess, loadCache } from '../lib/provider-cache.mjs';

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'scav-cachepriv-'));

describe('cache privacy invariant (§17)', () => {
  const FORBIDDEN = [
    'matchedSignals', 'missingSignals', 'reasons', 'penalties', 'score', 'band',
    'profileId', 'outcome', 'userId', 'email', 'phone', 'resume', '-jobId',
  ];
  it('provider cache values hold job listings only — never profile/user state', () => {
    const root = tmpRoot();
    // Simulate exactly what the engine stores: raw provider fetch results.
    const jobs = [{
      title: 'HR Director', company: 'Acme', location: 'Chicago, IL',
      url: 'https://j/1', description: 'talent acquisition, Workday',
      source: 'dice', postedAt: Date.now(),
    }];
    recordSuccess(root, 'dice', { jobIds: jobs.map((j) => j.url), jobCount: 1, jobsSnapshot: jobs });
    const entry = loadCache(root, 'dice');
    assert.ok(Array.isArray(entry.jobsSnapshot) && entry.jobsSnapshot.length === 1);
    const blob = JSON.stringify(entry.jobsSnapshot).toLowerCase();
    for (const key of FORBIDDEN) {
      assert.ok(!blob.includes(`"${key.toLowerCase()}"`), `forbidden key in cache: ${key}`);
    }
    // And the snapshot really is job data (usable without any profile).
    assert.equal(entry.jobsSnapshot[0].title, 'HR Director');
  });
});

describe('persistence integrity (§20)', () => {
  it('truncated/interrupted writes fail clearly and never poison state', async () => {
    const { openJobRepository } = await import('../lib/repositories/job-repository.mjs');
    const root = tmpRoot();
    const p = join(root, 'jobs.json');
    const jobs = openJobRepository(p);
    jobs.upsert([{ title: 'T', company: 'C', url: 'https://j/1', source: 'dice' }], Date.now());
    assert.equal(jobs.count(), 1);
    // Simulate a crash mid-write: torn JSON on disk.
    writeFileSync(p, '{"jobs": {"k": {"jobId": "k", "tit');
    assert.equal(jobs.count(), 0); // fails clearly → empty, never partial
    assert.equal(jobs.get('k'), null);
    // Recovery works: a later valid save is fully usable (no silent erase —
    // the torn bytes were already unreadable, nothing valid was lost).
    jobs.upsert([{ title: 'T2', company: 'C', url: 'https://j/2', source: 'dice' }], Date.now());
    assert.equal(jobs.count(), 1);
  });
});
