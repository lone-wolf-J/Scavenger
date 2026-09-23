import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverForProfiles } from '../lib/discovery-engine.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { loadStore } from '../lib/job-store.mjs';
import { mergeSourceQueries } from '../lib/job-store.mjs';

const NOW = Date.now();
const DAY = 86_400_000;
const HR3 = { id: 'hr', profile: normalizeCareerProfile({ targetRoles: ['HR Director', 'Talent Manager', 'Recruiter'], seniority: 'director', skills: ['Workday'] }) };

function mockJobs(jobs) {
  return {
    id: 'dice',
    detect: () => null,
    async fetch(entry) {
      return jobs.map((j) => ({ ...j, _fetchQuery: entry.query }));
    },
  };
}

describe('query provenance (§14)', () => {
  it('mergeSourceQueries: bounded, deduped, deterministic', () => {
    assert.deepEqual(mergeSourceQueries(null, 'dice', 'q1'), { dice: ['q1'] });
    assert.deepEqual(mergeSourceQueries({ dice: ['q1'] }, 'dice', 'q1'), { dice: ['q1'] });
    const m = mergeSourceQueries({ dice: ['q1'] }, 'dice', 'q2');
    assert.deepEqual(m, { dice: ['q1', 'q2'] });
    assert.deepEqual(mergeSourceQueries({ dice: ['q1'] }, null, null), { dice: ['q1'] });
    assert.deepEqual(mergeSourceQueries('nope', 'dice', 'q1'), { dice: ['q1'] });
    // Bounded at 10 per provider.
    let acc = null;
    for (let i = 0; i < 15; i++) acc = mergeSourceQueries(acc, 'd', `q${i}`);
    assert.equal(acc.d.length, 10);
  });

  it('multiple queries finding the same job: one record, all queries kept', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scav-prov-'));
    const job = { title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://j/1', postedAt: NOW - DAY, description: 'HR' };
    const seen = [];
    const mods = new Map([['dice', {
      id: 'dice', detect: () => null,
      async fetch(entry) { seen.push(entry.query); return [{ ...job }]; },
    }]]);
    const r = await discoverForProfiles({
      profiles: [HR3], providers: ['dice'], providerModules: mods,
      dataRoot: root, jobStorePath: join(root, 'store.json'),
      runsPath: join(root, 'runs.json'), now: NOW, maxQueries: 3,
    });
    assert.equal(r.status, 'COMPLETE');
    assert.ok(seen.length >= 2, `expected fan-out, got ${seen.length}`);
    const store = loadStore(join(root, 'store.json'));
    const ids = Object.keys(store.jobs);
    assert.equal(ids.length, 1); // canonical dedup: still one record
    const rec = store.jobs[ids[0]];
    assert.ok(Array.isArray(rec.sourceQueries?.dice) && rec.sourceQueries.dice.length === seen.length);
    // Second identical run: no duplicates, queries preserved.
    const r2 = await discoverForProfiles({
      profiles: [HR3], providers: ['dice'], providerModules: mods,
      dataRoot: root, jobStorePath: join(root, 'store.json'),
      runsPath: join(root, 'runs.json'), now: NOW + DAY, maxQueries: 3, refresh: true,
    });
    assert.equal(r2.jobsPersisted.added, 0);
    assert.equal(Object.keys(loadStore(join(root, 'store.json')).jobs).length, 1);
  });

  it('mockJobs helper is live (multi-query fan-out actually exercised)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scav-prov2-'));
    const mods = new Map([['dice', mockJobs([{ ...{ title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://j/9', postedAt: NOW - DAY, description: 'x' } }])]]);
    const r = await discoverForProfiles({
      profiles: [HR3], providers: ['dice'], providerModules: mods,
      dataRoot: root, jobStorePath: join(root, 's.json'), runsPath: join(root, 'r.json'),
      now: NOW, maxQueries: 2, dryRun: true,
    });
    assert.ok(r.funnel.raw >= 2); // same job returned per query → raw counts each hit
    assert.equal(r.jobsAccepted, 1);
  });
});
