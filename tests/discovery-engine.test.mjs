import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { discoverForProfiles, discoveryProviderStatus, validateDiscoveryLocation } from '../lib/discovery-engine.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { selectProfiles, emptyWorkspace, addProfile } from '../lib/scavenger-workspace.mjs';

const PROFILES = JSON.parse(readFileSync(new URL('./fixtures/test-profiles.json', import.meta.url), 'utf-8'));
const HR = { id: 'hr', profile: normalizeCareerProfile(PROFILES['hr-director']) };
const SWE = { id: 'swe', profile: normalizeCareerProfile(PROFILES['senior-swe']) };
const NOW = Date.now();
const DAY = 86_400_000;

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'scav-discover-'));

// Mocked providers: record every fetch call; never touch the network.
function mockProvider(id, jobs, { error = null, latencyMs = 0 } = {}, calls = []) {
  return {
    id,
    detect: () => null,
    async fetch(entry) {
      calls.push({ id, query: entry.query, location: entry.location });
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      if (error) throw error;
      return jobs.map((j) => ({ ...j }));
    },
  };
}

const errOf = (status, message = 'x') => Object.assign(new Error(message), { status });

const US_HR = { title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://a/1', postedAt: NOW - DAY, description: 'talent acquisition, Workday' };
const US_SWE = { title: 'Senior Software Engineer', company: 'Beta', location: 'Remote - US', url: 'https://b/2', postedAt: NOW - DAY, description: 'Python APIs' };
const CA_JOB = { title: 'HR Director', company: 'Maple', location: 'Toronto, Canada', url: 'https://c/3', postedAt: NOW - DAY, description: 'HR' };
const OLD_JOB = { title: 'HR Manager', company: 'Old', location: 'Austin, TX', url: 'https://o/4', postedAt: NOW - 30 * DAY, description: 'HR' };

describe('discovery-engine (§25)', () => {
  it('1: one profile discovers, filters, matches with funnel + timings', async () => {
    const calls = [];
    const mods = new Map([['dice', mockProvider('dice', [US_HR, CA_JOB], {}, calls)]]);
    const r = await discoverForProfiles({ profiles: [HR], providers: ['dice'], providerModules: mods, dataRoot: tmpRoot(), dryRun: true, now: NOW });
    assert.equal(r.status, 'COMPLETE');
    assert.equal(r.jobsDiscovered, r.queries.length * 2); // 2 jobs returned per query
    assert.equal(r.jobsAccepted, 1); // Canada rejected, same job deduped across queries
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].matches[0].profileId, 'hr');
    assert.ok(r.runId && r.timings.totalMs >= 0 && r.queries.length > 0);
  });
  it('2+3+16: overlapping profiles share one retrieval; queries deduped', async () => {
    const calls = [];
    const hr2 = { id: 'hr2', profile: normalizeCareerProfile({ ...PROFILES['hr-director'], targetRoles: ['HR Director'] }) };
    const mods = new Map([
      ['dice', mockProvider('dice', [US_HR], {}, calls)],
      ['linkedin', mockProvider('linkedin', [US_SWE], {}, calls)],
    ]);
    const r = await discoverForProfiles({ profiles: [HR, hr2, SWE], providers: ['dice', 'linkedin'], providerModules: mods, dataRoot: tmpRoot(), dryRun: true, now: NOW, maxQueries: 12 });
    const keys = calls.map((c) => `${c.id}::${c.query}`);
    assert.equal(keys.length, new Set(keys).size); // no duplicate (provider, query)
    const diceQueries = new Set(calls.filter((c) => c.id === 'dice').map((c) => c.query));
    assert.ok(diceQueries.size >= 1);
    assert.equal(r.matches.length, 2); // two unique jobs, displayed once each
    assert.ok(r.matches.every((m) => m.matches.length === 3));
  });
  it('4+5+13: failure isolated, BLOCKED surfaced, run PARTIAL', async () => {
    const calls = [];
    const blocked = errOf(403, 'HTTP 403 Forbidden');
    const mods = new Map([
      ['dice', mockProvider('dice', [US_HR], {}, calls)],
      ['indeed', mockProvider('indeed', [], { error: blocked }, calls)],
    ]);
    const r = await discoverForProfiles({ profiles: [HR], providers: ['dice', 'indeed'], providerModules: mods, dataRoot: tmpRoot(), dryRun: true, now: NOW });
    assert.equal(r.status, 'PARTIAL');
    assert.equal(r.providerHealth.indeed, 'BLOCKED');
    assert.equal(r.providerHealth.dice, 'ACTIVE');
    assert.equal(r.jobsAccepted, 1);
    assert.ok(r.errors.length >= 1 && r.errors.every((e) => e.provider === 'indeed' && e.errorType === 'BLOCKED'));
  });
  it('UNSUPPORTED adapters report honestly without jobs', async () => {
    const mods = new Map([['benchinfo', {
      id: 'benchinfo', detect: () => null,
      async fetch() { const e = new Error('no endpoint'); e.providerErrorType = 'UNSUPPORTED'; throw e; },
    }]]);
    const r = await discoverForProfiles({ profiles: [HR], providers: ['benchinfo'], providerModules: mods, dataRoot: tmpRoot(), dryRun: true, now: NOW });
    assert.equal(r.status, 'FAILED');
    assert.equal(r.providerHealth.benchinfo, 'UNSUPPORTED');
    assert.equal(r.jobsAccepted, 0);
  });
  it('6+7: US-only strict; freshness windows; undated passes', async () => {
    const calls = [];
    const undated = { ...US_HR, url: 'https://u/5', postedAt: undefined };
    const mods = new Map([['dice', mockProvider('dice', [US_HR, CA_JOB, OLD_JOB, undated], {}, calls)]]);
    const r = await discoverForProfiles({ profiles: [HR], providers: ['dice'], providerModules: mods, dataRoot: tmpRoot(), dryRun: true, now: NOW, maxAgeDays: 7 });
    const urls = r.matches.map((m) => m.jobId);
    assert.ok(urls.some((u) => u.includes('hr director') || u.includes('a/1')));
    assert.ok(r.matches.length === 2); // a/1 + u/5 (undated passes; o/4 too old, c/3 non-US)
    assert.ok(!urls.some((u) => u.includes('c/3') || u.includes('o/4')));
    assert.equal(r.funnel.us, r.queries.length * 3); // a/1, o/4, u/5 per query
    assert.equal(r.funnel.fresh, r.queries.length * 2); // o/4 too old
  });
  it('8: upsert persists canonical jobs; rerun updates instead of duplicating', async () => {
    const calls = [];
    const root = tmpRoot();
    const storePath = join(root, 'store.json');
    const mods = new Map([['dice', mockProvider('dice', [US_HR], {}, calls)]]);
    const base = { profiles: [HR], providers: ['dice'], providerModules: mods, dataRoot: root, jobStorePath: storePath, now: NOW };
    const r1 = await discoverForProfiles(base);
    assert.deepEqual([r1.jobsPersisted.added, r1.jobsPersisted.updated], [1, 0]);
    const r2 = await discoverForProfiles({ ...base, refresh: true });
    assert.equal(r2.jobsPersisted.added, 0);
    assert.ok(r2.jobsPersisted.updated + r2.jobsPersisted.unchanged >= 1);
  });
  it('9+10+11: cross-provider dupes merge; both profiles scored; displayed once', async () => {
    const calls = [];
    const dup = { ...US_HR, url: 'https://other/9' }; // same title/company/location/date, other URL
    const mods = new Map([
      ['dice', mockProvider('dice', [US_HR], {}, calls)],
      ['linkedin', mockProvider('linkedin', [dup], {}, calls)],
    ]);
    const r = await discoverForProfiles({ profiles: [HR, SWE], providers: ['dice', 'linkedin'], providerModules: mods, dataRoot: tmpRoot(), dryRun: true, now: NOW });
    assert.equal(r.jobsAccepted, 1);
    assert.equal(r.jobsDeduplicated, r.jobsDiscovered - 1); // everything else merged
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].matches.length, 2);
  });
  it('12+21: second identical run reuses cache (no refetch)', async () => {
    const calls = [];
    const root = tmpRoot();
    const mods = new Map([['dice', mockProvider('dice', [US_HR], {}, calls)]]);
    const base = { profiles: [HR], providers: ['dice'], providerModules: mods, dataRoot: root, now: NOW };
    await discoverForProfiles(base);
    const afterFirst = calls.length;
    assert.ok(afterFirst > 0);
    const r2 = await discoverForProfiles(base);
    assert.equal(calls.length, afterFirst); // cache hit: zero new fetches
    assert.equal(r2.jobsAccepted, 1);
  });
  it('14: structured reporting contract', async () => {
    const mods = new Map([['dice', mockProvider('dice', [US_HR], {})]]);
    const r = await discoverForProfiles({ profiles: [HR], providers: ['dice'], providerModules: mods, dataRoot: tmpRoot(), dryRun: true, now: NOW });
    for (const k of ['runId', 'startedAt', 'completedAt', 'profiles', 'queries', 'providers', 'jobsDiscovered', 'jobsAccepted', 'jobsDeduplicated', 'jobsPersisted', 'matches', 'providerHealth', 'errors', 'timings', 'funnel', 'discovery']) {
      assert.ok(k in r, `missing ${k}`);
    }
    assert.ok(r.providers[0].uniqueEmployers >= 1 && r.providers[0].runtimeMs >= 0);
  });
  it('15: unknown profile ids never reach matching (workspace boundary)', () => {
    const ws = emptyWorkspace();
    const rec = addProfile(ws, { name: 'HR', profile: PROFILES['hr-director'] });
    assert.deepEqual(selectProfiles(ws, [rec.id, 'ghost']), [rec.id]);
    assert.deepEqual(selectProfiles(ws, ['ghost']), []);
  });
  it('validation rejects unsafe input before any fetch', async () => {
    const calls = [];
    const mods = new Map([['dice', mockProvider('dice', [US_HR], {}, calls)]]);
    const root = tmpRoot();
    await assert.rejects(discoverForProfiles({ profiles: [], providerModules: mods, dataRoot: root }), /at least one profile/);
    await assert.rejects(discoverForProfiles({ profiles: [{ id: 'x', profile: {} }], providerModules: mods, dataRoot: root }), /no target roles/);
    await assert.rejects(discoverForProfiles({ profiles: [HR], providers: ['nope'], providerModules: mods, dataRoot: root }), /unknown provider/);
    await assert.rejects(discoverForProfiles({ profiles: [HR], location: 'Toronto, Canada', providerModules: mods, dataRoot: root }), /US/);
    await assert.rejects(discoverForProfiles({ profiles: [HR], maxAgeDays: 30, providerModules: mods, dataRoot: root }), /maxAgeDays/);
    await assert.rejects(discoverForProfiles({ profiles: [HR], maxQueries: 99, providerModules: mods, dataRoot: root }), /maxQueries/);
    assert.equal(calls.length, 0); // nothing fetched
    assert.throws(() => validateDiscoveryLocation('Berlin, Germany'), /US/);
    assert.equal(validateDiscoveryLocation(''), 'United States');
  });
  it('status mapper covers the closed set', () => {
    assert.equal(discoveryProviderStatus({ succeeded: 1, failed: 1 }), 'ACTIVE');
    assert.equal(discoveryProviderStatus({ succeeded: 0, failed: 1, lastErrorType: 'REQUIRES_AUTH' }), 'AUTH_REQUIRED');
    assert.equal(discoveryProviderStatus({ succeeded: 0, failed: 1, lastErrorType: 'RATE_LIMITED' }), 'RATE_LIMITED');
    assert.equal(discoveryProviderStatus({ succeeded: 0, failed: 1, lastErrorType: 'UNAVAILABLE' }), 'TEMPORARILY_UNAVAILABLE');
    assert.equal(discoveryProviderStatus({ succeeded: 0, failed: 1, lastErrorType: 'FETCH_ERROR' }), 'ERROR');
  });
});
