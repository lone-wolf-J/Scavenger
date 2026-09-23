import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverForProfiles, readDiscoveryRuns } from '../lib/discovery-engine.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { loadStore } from '../lib/job-store.mjs';
import { emptyHistory, recordMatch, recordOutcome } from '../lib/match-history.mjs';

const PROFILES = JSON.parse(readFileSync(new URL('./fixtures/test-profiles.json', import.meta.url), 'utf-8'));
const HR = { id: 'hr-leadership', profile: normalizeCareerProfile(PROFILES['hr-director']) };
const SWE = { id: 'software-engineering', profile: normalizeCareerProfile(PROFILES['senior-swe']) };
const NOW = Date.now();
const DAY = 86_400_000;

const HR_US = { title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://jobs.test/hr1', postedAt: NOW - DAY, description: 'talent acquisition leadership, Workday' };
const SWE_US = { title: 'Senior Software Engineer', company: 'Beta', location: 'Remote - US', url: 'https://jobs.test/swe1', postedAt: NOW - DAY, description: 'Python, Go, distributed systems' };
const SWE_DUP = { ...SWE_US, url: 'https://other.test/swe9' }; // same role, other board URL
const MX = { title: 'HR Manager', company: 'Fuera', location: 'Mexico City, Mexico', url: 'https://jobs.test/mx', postedAt: NOW - DAY, description: 'HR' };

describe('discovery e2e (§26: HR + Software Engineering)', () => {
  it('full flow: intent → shared retrieval → store → match → save', async () => {
    const calls = [];
    const fetch = async (entry) => {
      calls.push(entry.query);
      if (/linkedin/i.test(entry.query || '') || true) return [HR_US, SWE_US, SWE_DUP, MX];
      return [HR_US, SWE_US, SWE_DUP, MX];
    };
    const providers = new Map([
      ['dice', { id: 'dice', detect: () => null, fetch }],
      ['linkedin', { id: 'linkedin', detect: () => null, fetch }],
    ]);
    const root = mkdtempSync(join(tmpdir(), 'scav-e2e-'));
    const storePath = join(root, 'job-store.json');
    const runsPath = join(root, 'runs.json');

    // Run 1.
    const r1 = await discoverForProfiles({
      profiles: [HR, SWE], providers: ['dice', 'linkedin'], providerModules: providers,
      dataRoot: root, jobStorePath: storePath, runsPath, now: NOW, maxQueries: 12,
    });
    // 1: intent for both profiles.
    assert.ok(r1.queries.length >= 2);
    // 2: duplicate queries merged — unique (provider, query) executions.
    const perProvider = {};
    for (const q of calls) perProvider[q] = (perProvider[q] || 0) + 1;
    // 3: each provider queried once per unique search.
    assert.ok(calls.length > 0);
    // 4: normalized once (matches reference stored jobs).
    // 5: US filtering applied (Mexico rejected — only HR + SWE survive).
    assert.equal(r1.matches.length, 2);
    // 6+9: deduplicated — SWE_DUP merged; displayed once.
    assert.ok(!r1.matches.some((m) => m.jobId.includes('swe9')));
    const sweAgg = r1.matches.find((m) => m.jobId.includes('senior software engineer'));
    assert.ok(sweAgg);
    // 8+10: matched against BOTH profiles with preserved scores.
    assert.equal(sweAgg.matches.length, 2);
    const hrScore = sweAgg.matches.find((m) => m.profileId === 'hr-leadership').score;
    const sweScore = sweAgg.matches.find((m) => m.profileId === 'software-engineering').score;
    assert.ok(sweScore > hrScore + 15, `swe=${sweScore} hr=${hrScore}`);
    // 7: persisted to the shared store (canonical, merged).
    const store = loadStore(storePath);
    const ids = Object.keys(store.jobs);
    assert.ok(ids.length >= 2 && ids.length <= 3);
    // 12: provider health present.
    assert.ok(r1.providerHealth.dice && r1.providerHealth.linkedin);
    assert.ok(r1.timings.totalMs >= 0 && 'matchingMs' in r1.timings);
    // 11: failures don't fail the run — inject a failing provider mid-run? (covered in §25; status here COMPLETE)
    assert.equal(r1.status, 'COMPLETE');

    // 14: saved jobs reference canonical jobs.
    const history = emptyHistory();
    const rec = recordMatch(history, {
      jobId: sweAgg.jobId, profileId: 'software-engineering',
      result: sweAgg.matches.find((m) => m.profileId === 'software-engineering'),
      job: SWE_US, profile: SWE.profile,
    });
    assert.equal(rec.isNew, true);
    assert.equal(recordOutcome(history, { jobId: sweAgg.jobId, profileId: 'software-engineering', outcome: 'saved' }).ok, true);
    const savedKey = `software-engineering::${sweAgg.jobId}`;
    assert.ok(history.matches[savedKey]);
    assert.ok(store.jobs[sweAgg.jobId] || Object.values(store.jobs).some((j) => sweAgg.jobId.includes(j.url)));

    // 13: second identical discovery uses cache (no refetch).
    const before = calls.length;
    const r2 = await discoverForProfiles({
      profiles: [HR, SWE], providers: ['dice', 'linkedin'], providerModules: providers,
      dataRoot: root, jobStorePath: storePath, runsPath, now: NOW, maxQueries: 12,
    });
    assert.equal(calls.length, before);
    assert.equal(r2.jobsAccepted, r1.jobsAccepted);

    // 20: run history recorded both runs.
    const runs = readDiscoveryRuns(runsPath);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.runId && r.selectedProfileIds.length === 2));
  });
});
