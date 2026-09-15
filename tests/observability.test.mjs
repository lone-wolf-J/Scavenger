import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { providerStatus, providerSignalScore, loadSignalWeights } from '../scan.mjs';
import { normalizeProviderJob, jobProvenance } from '../lib/job-model.mjs';
import { runProvider } from '../lib/provider-result.mjs';
import { loadCache, isFresh, recordSuccess, cacheScope } from '../lib/provider-cache.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stat = (over = {}) => ({
  attempted: 1, succeeded: 0, failed: 1, jobs: 0, errorTypes: {},
  raw: 0, us: 0, fresh: 0, accepted: 0, dupes: 0, scoreSum: 0, scored: 0,
  highMatch: 0, employers: new Set(), newEmployers: 0, runtimeMs: 0, lastErrorType: '', ...over,
});

describe('provider status + ROI signal', () => {
  it('maps terminal states explicitly, ACTIVE on any success', () => {
    assert.equal(providerStatus(stat({ lastErrorType: 'UNSUPPORTED' })), 'UNSUPPORTED');
    assert.equal(providerStatus(stat({ lastErrorType: 'BLOCKED' })), 'BLOCKED');
    assert.equal(providerStatus(stat({ lastErrorType: 'REQUIRES_AUTH' })), 'AUTH_REQUIRED');
    assert.equal(providerStatus(stat({ lastErrorType: 'RATE_LIMITED' })), 'RATE_LIMITED');
    assert.equal(providerStatus(stat({ lastErrorType: 'UNAVAILABLE' })), 'TEMPORARILY_UNAVAILABLE');
    assert.equal(providerStatus(stat({ lastErrorType: 'FETCH_ERROR' })), 'ERROR');
    assert.equal(providerStatus(stat({ succeeded: 2, failed: 1, lastErrorType: 'BLOCKED' })), 'ACTIVE');
    assert.equal(providerStatus(null), 'ERROR');
  });
  it('ranks 5 excellent jobs above 5000 irrelevant ones', () => {
    const great = providerSignalScore({ accepted: 5, uniqueEmployers: 4, highMatch: 5, freshAccepted: 5 });
    const spam = providerSignalScore({ accepted: 2, uniqueEmployers: 1, highMatch: 0, freshAccepted: 2, fresh: 5000 });
    assert.ok(great > spam, `great=${great} spam=${spam}`);
    const custom = providerSignalScore({ accepted: 1, uniqueEmployers: 0, highMatch: 0, fresh: 0 }, { accepted: 10, uniqueEmployers: 0, highMatch: 0, fresh: 0 });
    assert.equal(custom, 10);
  });
  it('loads signal weights with safe defaults', () => {
    const w = loadSignalWeights('/nonexistent/matching.yml');
    assert.deepEqual(w, { accepted: 3, uniqueEmployers: 2, highMatch: 4, fresh: 1 });
  });
});

describe('MCP-agnostic provider contract', () => {
  it('uses provider.normalize when present, shared model otherwise', async () => {
    const raw = { title: 'T', url: 'https://x/y', company: 'C', location: 'Austin, TX' };
    const plain = normalizeProviderJob({ id: 'x' }, raw, 'x');
    assert.equal(plain.source, 'x');
    assert.equal(plain.state, 'TX');
    const custom = normalizeProviderJob({
      id: 'mcp', normalize: (r) => ({ ...r, state: 'CA', source: 'mcp-board' }),
    }, raw, 'mcp');
    assert.equal(custom.state, 'CA');
    assert.equal(custom.source, 'mcp-board');
    // A throwing hook never loses the job.
    const broken = normalizeProviderJob({ id: 'b', normalize: () => { throw new Error('nope'); } }, raw, 'b');
    assert.equal(broken.title, 'T');
  });
  it('runProvider honors provider-declared terminal states', async () => {
    const p = { id: 'bench', fetch: async () => { const e = new Error('no endpoint'); e.providerErrorType = 'UNSUPPORTED'; throw e; } };
    const res = await runProvider(p, {}, {});
    assert.equal(res.errorType, 'UNSUPPORTED');
    assert.ok(!res.message.startsWith('bench: bench'));
  });
});

describe('job provenance', () => {
  it('answers where/what/canonical/who/evidence', () => {
    const prov = jobProvenance({
      title: 'T', url: 'https://dice.com/j/1', applyUrl: 'https://acme.com/a',
      source: 'dice', sources: ['dice', 'linkedin'], sourceJobId: '1',
      company: 'Acme', matchReasons: ['US remote'], discoveredAt: 5, postedAt: 6,
    });
    assert.equal(prov.originUrl, 'https://dice.com/j/1');
    assert.deepEqual(prov.sources, ['dice', 'linkedin']);
    assert.equal(prov.employer, 'Acme');
    assert.deepEqual(prov.employerEvidence, ['US remote']);
    assert.equal(prov.sourceJobId, '1');
  });
});

describe('incremental scanning', () => {
  it('second pass within TTL reuses the snapshot without fetching', async () => {
    const root = mkdtempSync(join(tmpdir(), 'career-ops-incr-'));
    const scope = cacheScope('dice', { query: 'AI', name: 'Dice US' });
    // Tenant isolation: same provider, different entry → different slot.
    assert.notEqual(scope, cacheScope('dice', { query: 'HR', name: 'Dice HR' }));
    // Pass 1: fetch + record.
    let fetches = 0;
    const jobs = [{ title: 'T', url: 'https://x/1', company: 'C', location: 'Austin, TX' }];
    const fetched = await (async () => { fetches++; return jobs; })();
    recordSuccess(root, scope, { jobIds: fetched.map((j) => j.url), jobCount: 1, jobsSnapshot: fetched });
    // Pass 2: fresh cache → no fetch.
    const cached = loadCache(root, scope);
    assert.ok(isFresh(cached));
    const before = fetches;
    const reused = Array.isArray(cached.jobsSnapshot) ? cached.jobsSnapshot : await (async () => { fetches++; return []; })();
    assert.equal(fetches, before);
    assert.equal(reused.length, 1);
    // Pass 3 (stale): refetch happens.
    assert.equal(isFresh({ lastSuccess: Date.now() - 3600_000 }, 1000), false);
  });
});
