import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverForProfiles, readDiscoveryRuns } from '../lib/discovery-engine.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { loadStore } from '../lib/job-store.mjs';
import { refreshLifecycle } from '../lib/job-diff.mjs';
import {
  emptyHistory, recordMatch, markViewed, recordOutcome, getJobView,
} from '../lib/match-history.mjs';
import { buildChangeFeed, feedSummary } from '../lib/change-feed.mjs';
import { computeOutcomeMetrics } from '../lib/outcome-metrics.mjs';

const PROFILES = JSON.parse(readFileSync(new URL('./fixtures/test-profiles.json', import.meta.url), 'utf-8'));
const HR = { id: 'hr', profile: normalizeCareerProfile(PROFILES['hr-director']) };
const NOW = Date.now();
const DAY = 86_400_000;

describe('intel e2e (profile → discover → diff → feed → outcomes)', () => {
  it('full loop with a mid-stream job change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scav-intel-e2e-'));
    const storePath = join(root, 'job-store.json');
    const runsPath = join(root, 'runs.json');
    let jobs = [
      { title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://j/1', postedAt: NOW - DAY, description: 'talent acquisition, Workday', salary: { min: 140000, max: 180000, currency: 'USD' } },
    ];
    const mods = new Map([['dice', {
      id: 'dice', detect: () => null,
      async fetch() { return jobs.map((j) => ({ ...j })); },
    }]]);
    const base = { profiles: [HR], providers: ['dice'], providerModules: mods, dataRoot: root, jobStorePath: storePath, runsPath, now: NOW };

    // Run 1: discover → canonical store (1 added).
    const r1 = await discoverForProfiles(base);
    assert.equal(r1.status, 'COMPLETE');
    assert.equal(r1.jobsPersisted.added, 1);
    const [agg1] = r1.matches;
    assert.ok(agg1.best.score >= 60);

    // Match explanations: score + band + reasons + version, never bare.
    const m1 = agg1.matches[0];
    assert.ok(m1.score != null && m1.band && m1.reasons.length > 0 && m1.scoringVersion === '1.0');

    // Save/view/reject → persisted outcomes with timestamps.
    const history = emptyHistory();
    recordMatch(history, { jobId: agg1.jobId, profileId: 'hr', result: m1, job: jobs[0], profile: HR.profile, now: NOW });
    markViewed(history, { jobId: agg1.jobId, profileId: 'hr', now: NOW + 1 });
    assert.equal(recordOutcome(history, { jobId: agg1.jobId, profileId: 'hr', outcome: 'saved', now: NOW + 2 }).ok, true);
    const h1 = history.matches[`hr::${agg1.jobId}`];
    assert.ok(h1.firstViewedAt && h1.firstSavedAt && h1.scoringVersion === '1.0');

    // Run 2: the posting changes salary + description (same URL).
    jobs = [{ ...jobs[0], salary: { min: 160000, max: 200000, currency: 'USD' }, description: 'talent acquisition, Workday, Greenhouse' }];
    const r2 = await discoverForProfiles({ ...base, refresh: true, now: NOW + DAY });
    assert.equal(r2.jobsPersisted.added, 0); // no duplicate
    assert.ok(r2.changes.some((c) => c.changedFields.includes('salary')), JSON.stringify(r2.changes));

    // Feed: CHANGED derived from persisted diffs; no new fake activity.
    const store = loadStore(storePath);
    const feed = buildChangeFeed({ store, history, run: { completedAt: r1.completedAt }, changes: r2.changes, now: NOW + DAY });
    const summary = feedSummary(feed);
    assert.ok(summary.changed >= 1);
    assert.ok(feed.every((i) => i.jobId && i.title !== undefined));

    // Lifecycle: untouched long enough → stale (deterministic, no provider input).
    const lc = refreshLifecycle(store, { now: NOW + 60 * DAY });
    assert.equal(lc.stale + lc.active + lc.closed, Object.keys(store.jobs).length);

    // Run history: both runs recorded with expanded fields.
    const runs = readDiscoveryRuns(runsPath);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.durationMs != null && r.matchesByProfile?.hr && Array.isArray(r.queries)));

    // Outcome metrics: measurement only (saved counted, weights untouched).
    const metrics = computeOutcomeMetrics(history);
    assert.equal(metrics.totals.saved, 1);

    // Profile-aware view: one job, per-profile state, no duplication.
    const view = getJobView(history, { jobId: agg1.jobId, profileIds: ['hr'] });
    assert.equal(view.profiles.hr.outcome, 'saved');
    assert.equal(Object.keys(store.jobs).length, 1); // still one canonical record
  });
});
