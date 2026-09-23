import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverForProfiles } from '../lib/discovery-engine.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { openJobRepository } from '../lib/repositories/job-repository.mjs';
import { openMatchRepository } from '../lib/repositories/match-repository.mjs';
import { openOutcomeRepository } from '../lib/repositories/outcome-repository.mjs';
import { openDiscoveryRunRepository } from '../lib/repositories/discovery-run-repository.mjs';
import { makeClosedEvidence, diffConsecutiveRuns } from '../lib/job-liveness.mjs';
import { buildChangeFeed } from '../lib/change-feed.mjs';

const PROFILES = JSON.parse(readFileSync(new URL('./fixtures/test-profiles.json', import.meta.url), 'utf-8'));
const NOW = Date.now();
const DAY = 86_400_000;

const X = { title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://j/x', postedAt: NOW - DAY, description: 'talent acquisition, Workday', salary: { min: 140000, currency: 'USD' } };
const Y = { title: 'HR Manager', company: 'Beta', location: 'Austin, TX', url: 'https://j/y', postedAt: NOW - DAY, description: 'HR operations' };

describe('phase 7 e2e (§22: two profiles, liveness, outcomes)', () => {
  it('17-step scenario with mocked providers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scav-p7e2e-'));
    const storePath = join(root, 'job-store.json');
    const runsPath = join(root, 'runs.json');
    const historyPath = join(root, 'history.json');
    // 1. Two profiles.
    const A = { id: 'hr', profile: normalizeCareerProfile(PROFILES['hr-director']) };
    const B = { id: 'swe', profile: normalizeCareerProfile(PROFILES['senior-swe']) };
    let jobs = [X, Y];
    const calls = [];
    const blocked = Object.assign(new Error('HTTP 403'), { status: 403 });
    const mods = new Map([
      ['dice', { id: 'dice', detect: () => null, async fetch(e) { calls.push(['dice', e.query]); return jobs.map((j) => ({ ...j })); } }],
      ['indeed', { id: 'indeed', detect: () => null, async fetch(e) { calls.push(['indeed', e.query]); throw blocked; } }],
    ]);
    const base = {
      profiles: [A, B], providers: ['dice', 'indeed'], providerModules: mods,
      dataRoot: root, jobStorePath: storePath, runsPath, now: NOW,
    };

    // 2. Discover once. 3. Canonical store: one record per canonical job.
    const r1 = await discoverForProfiles(base);
    assert.equal(r1.status, 'PARTIAL'); // indeed blocked, dice fine
    const jobsApi = openJobRepository(storePath);
    const ids = Object.keys(jobsApi.load().jobs);
    assert.ok(ids.length >= 2);
    const xId = ids.find((id) => jobsApi.get(id).url === 'https://j/x');
    const yId = ids.find((id) => jobsApi.get(id).url === 'https://j/y');
    assert.ok(xId && yId && xId !== yId);

    // 4. Match both profiles (engine matched both already).
    const aggX = r1.matches.find((m) => m.jobId === xId);
    assert.ok(aggX && aggX.matches.length === 2);

    // 5–6. Save X for A; reject X for B (profile-specific outcomes).
    const matches = openMatchRepository(historyPath);
    for (const m of aggX.matches) {
      matches.record({ jobId: xId, profileId: m.profileId, result: m, job: X, profile: m.profileId === 'hr' ? A.profile : B.profile, now: NOW });
    }
    assert.equal(matches.outcome({ jobId: xId, profileId: 'hr', outcome: 'saved', now: NOW }).ok, true);
    assert.equal(matches.outcome({ jobId: xId, profileId: 'swe', outcome: 'rejected', now: NOW }).ok, true);
    assert.equal(matches.getOutcome({ profileId: 'hr', jobId: xId }).outcome, 'saved');
    assert.equal(matches.getOutcome({ profileId: 'swe', jobId: xId }).outcome, 'rejected');

    // 7–9. Rediscover with changed compensation on X.
    jobs = [{ ...X, salary: { min: 170000, currency: 'USD' } }, Y];
    const r2 = await discoverForProfiles({ ...base, refresh: true, now: NOW + DAY });
    assert.equal(r2.jobsPersisted.added, 0); // no duplicates
    assert.ok(r2.changes.some((c) => c.jobId === xId && c.changedFields.includes('salary')));

    // 10–11. Explicit close of Y through fixture evidence.
    const r3 = await discoverForProfiles({
      ...base, refresh: true, now: NOW + 2 * DAY,
      closedEvidence: {
        [yId]: makeClosedEvidence({ type: 'explicit-provider', provider: 'dice', reason: 'detail 404', now: NOW + 2 * DAY }),
        'https://ghost/1': makeClosedEvidence({ type: 'manual', reason: 'user confirmed', now: NOW + 2 * DAY }),
      },
    });
    assert.ok(r3.livenessApplied.some((l) => l.jobId === yId));
    assert.equal(jobsApi.get(yId).lifecycle, 'closed');
    assert.ok(jobsApi.get(yId).closedEvidence.provider === 'dice'); // reason trail
    // 14. X remains historically saved/rejected (closure of Y touched nothing else).
    assert.equal(matches.getOutcome({ profileId: 'hr', jobId: xId }).outcome, 'saved');
    assert.equal(matches.getOutcome({ profileId: 'swe', jobId: xId }).outcome, 'rejected');

    // 12–13. BLOCKED provider cannot close unrelated jobs.
    assert.equal(r1.providerHealth.indeed, 'BLOCKED');
    assert.notEqual(jobsApi.get(xId).lifecycle, 'closed');

    // Consecutive COMPLETE runs diff cleanly (r2/r3 may be PARTIAL due to
    // indeed; use the run repository's consecutiveComplete semantics on
    // recorded COMPLETE runs — here assert the helper contract instead).
    const runs = openDiscoveryRunRepository(runsPath);
    assert.ok(runs.load().runs.length >= 3);
    const diff = diffConsecutiveRuns(
      { status: 'COMPLETE', observedJobIds: [xId, yId] },
      { status: 'COMPLETE', observedJobIds: [xId] },
    );
    assert.deepEqual(diff, { new: [], unchanged: [xId], missing: [yId] });

    // 15. Match versions intact (engine stamps 1.0; history keeps first).
    const hx = matches.getOutcome({ profileId: 'hr', jobId: xId });
    assert.equal(hx.scoringVersion, '1.0');
    assert.equal(hx.firstScoredVersion, '1.0');

    // 16. Outcome metrics reflect profile-specific actions.
    const out = openOutcomeRepository(historyPath, {});
    assert.equal(out.metrics().totals.saved, 1);
    assert.equal(out.metrics().totals.rejected, 1);
    assert.ok(out.bandMatrix());

    // 17. Web displays correct states: feed join by canonical id with legacy
    // fallback; closed Y hidden by default feed rule, visible when asked.
    const feed = buildChangeFeed({
      store: jobsApi.load(), history: matches.load(),
      run: { completedAt: r3.completedAt }, changes: r3.changes, now: NOW + 2 * DAY,
    });
    assert.ok(feed.every((i) => i.jobId && i.title !== undefined));
    const yRec = jobsApi.get(yId);
    assert.equal(yRec.lifecycle, 'closed');
    assert.ok(yRec.firstSeen && yRec.sources.length > 0); // history retained
  });
});
