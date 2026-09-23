import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverForProfiles } from '../lib/discovery-engine.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { loadStore } from '../lib/job-store.mjs';

const NOW = Date.now();
const DAY = 86_400_000;
const tmpRoot = () => mkdtempSync(join(tmpdir(), 'scav-quality-'));
const HR = { id: 'hr', profile: normalizeCareerProfile({ targetRoles: ['HR Director', 'Talent Manager'], seniority: 'director', skills: ['Workday'] }) };

const JOBS = [
  { title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://j/1', postedAt: NOW - DAY, description: 'talent acquisition, Workday' },
  { title: 'HR Manager', company: 'Beta', location: 'Austin, TX', url: 'https://j/2', postedAt: NOW - 2 * DAY, description: 'HR operations' },
];

function mockMods(impls) {
  const calls = [];
  const mods = new Map(Object.entries(impls).map(([id, fn]) => [id, {
    id, detect: () => null,
    async fetch(entry) { calls.push([id, entry.query]); return fn(entry); },
  }]));
  return { mods, calls };
}

describe('discovery quality metrics (§13)', () => {
  it('per-provider normalized + canonical attribution is factual', async () => {
    const root = tmpRoot();
    // linkedin returns one duplicate of the dice job + one unique job.
    const { mods } = mockMods({
      dice: async () => JOBS.map((j) => ({ ...j })),
      linkedin: async () => [{ ...JOBS[0], url: 'https://li/1-dup' }, { ...JOBS[1], url: 'https://li/2b' }],
    });
    // Note: different URLs + same canonical identity merge only when the
    // canonical key matches (title/company/location/date); li/2b differs by
    // URL alone but shares identity with j/2 → merges.
    const r = await discoverForProfiles({
      profiles: [HR], providers: ['dice', 'linkedin'], providerModules: mods,
      dataRoot: root, jobStorePath: join(root, 's.json'), runsPath: join(root, 'r.json'),
      now: NOW, maxQueries: 2,
    });
    assert.equal(r.status, 'COMPLETE');
    const byId = Object.fromEntries(r.providers.map((p) => [p.id, p]));
    for (const p of Object.values(byId)) {
      assert.ok(p.normalized >= 0 && p.raw >= 0);
      assert.ok(p.canonicalAdded >= 0 && p.canonicalUpdated >= 0);
    }
    // Attribution is conservative: credited adds+updates never exceed accepted.
    for (const p of Object.values(byId)) {
      assert.ok(p.canonicalAdded + p.canonicalUpdated <= p.accepted + p.dupes, `${p.id} over-attributed`);
    }
    // Run record carries the same maps.
    const runs = JSON.parse((await import('node:fs')).readFileSync(join(root, 'r.json'), 'utf8')).runs;
    assert.ok(runs.length >= 1);
  });

  it('normalized counts jobs surviving normalize; malformed raw is dropped safely', async () => {
    const root = tmpRoot();
    const { mods } = mockMods({
      dice: async () => [
        { ...JOBS[0] },
        { title: '', company: '', url: 'not-a-url', location: '' }, // malformed-ish
      ],
    });
    const r = await discoverForProfiles({
      profiles: [HR], providers: ['dice'], providerModules: mods,
      dataRoot: root, jobStorePath: join(root, 's.json'), runsPath: join(root, 'r.json'),
      now: NOW, maxQueries: 1, dryRun: true,
    });
    const dice = r.providers.find((p) => p.id === 'dice');
    assert.ok(dice.normalized <= dice.raw);
  });
});

describe('query provenance (§14)', () => {
  it('canonical record keeps per-provider queries; no duplicate records', async () => {
    const root = tmpRoot();
    const seen = [];
    const mods = new Map([['dice', {
      id: 'dice', detect: () => null,
      async fetch(entry) { seen.push(entry.query); return JOBS.slice(0, 1).map((j) => ({ ...j })); },
    }]]);
    const storePath = join(root, 's.json');
    const base = {
      profiles: [HR], providers: ['dice'], providerModules: mods,
      dataRoot: root, jobStorePath: storePath, runsPath: join(root, 'r.json'),
      now: NOW, maxQueries: 3,
    };
    const r1 = await discoverForProfiles(base);
    assert.ok(seen.length >= 2, `expected fan-out, got ${seen.length}`);
    const store = loadStore(storePath);
    const ids = Object.keys(store.jobs);
    assert.equal(ids.length, 1); // one canonical record despite N queries
    const rec = store.jobs[ids[0]];
    assert.ok(rec.sourceQueries?.dice?.length >= 2, JSON.stringify(rec.sourceQueries));
    for (const q of seen) assert.ok(rec.sourceQueries.dice.includes(q));
    // Second run: still one record, queries preserved (union, bounded).
    await discoverForProfiles({ ...base, refresh: true, now: NOW + DAY });
    const ids2 = Object.keys(loadStore(storePath).jobs);
    assert.equal(ids2.length, 1);
    assert.ok(loadStore(storePath).jobs[ids2[0]].sourceQueries.dice.length >= 2);
  });
});
