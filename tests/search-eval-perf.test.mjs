// Search-evaluation performance (local, deterministic, stub providers).
// Proves profile count does not multiply retrieval, and aggregation stays
// in budget. No network anywhere in this file.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateSearchAcrossProfiles } from '../lib/search-eval.mjs';
import { computeSearchQuality } from '../lib/search-quality.mjs';
import { computeOutcomeMetrics } from '../lib/outcome-metrics.mjs';
import { matchPool } from '../lib/matcher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const loadProfiles = (n) => {
  const all = readdirSync(join(HERE, 'fixtures', 'eval-profiles'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'eval-profiles', f), 'utf8')));
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const base = all[i % all.length];
    out.push({ id: `${base.id}-c${i}`, profile: base.profile });
  }
  return out;
};

const stubProvider = (id, jobs) => ({
  id,
  async fetch() { return jobs.map((j) => ({ ...j })); },
});
const mkJobs = (n, tag) => {
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push({
      title: `Engineer ${i}`, url: `https://${tag}.example.com/${i}`, company: `Co${i % 20}`,
      location: 'Austin, TX', description: `Python engineering systems role ${i}`,
      postedAt: Date.now(), source: tag,
    });
  }
  return jobs;
};

describe('evaluation performance (local)', () => {
  for (const n of [5, 10]) {
    it(`${n}-profile discovery shares retrieval and stays in budget`, async () => {
      const profiles = loadProfiles(n);
      const mods = new Map([['stub-a', stubProvider('stub-a', mkJobs(40, 'a'))], ['stub-b', stubProvider('stub-b', mkJobs(40, 'b'))]]);
      const t0 = Date.now();
      const out = await evaluateSearchAcrossProfiles({ profiles, providerModules: mods, providers: ['stub-a', 'stub-b'], maxQueries: 6 });
      const dt = Date.now() - t0;
      assert.equal(out.sharedPlan.profiles, n);
      assert.equal(out.sharedPlan.shared, true);
      // Retrieval count is bounded by providers × merged queries — never
      // profiles × queries. Five or ten profiles, same ceiling.
      assert.ok(out.sharedPlan.executedRetrievals <= 2 * out.sharedPlan.mergedQueries);
      console.log(`      ${n}-profile discovery+eval: ${dt}ms (${out.sharedPlan.executedRetrievals} retrievals)`);
      assert.ok(dt < 60000, `${n}-profile budget exceeded`);
    });
  }

  it('multi-profile matching at 1k jobs stays in budget', async () => {
    const profiles = loadProfiles(5).map((p) => ({ id: p.id, profile: p.profile }));
    const jobs = mkJobs(1000, 'm');
    const t0 = Date.now();
    const pool = matchPool(jobs, profiles, {});
    const dt = Date.now() - t0;
    assert.ok(pool.length > 0);
    console.log(`      1k-job × 5-profile matchPool: ${dt}ms`);
    assert.ok(dt < 30000, 'match budget exceeded');
  });

  it('outcome aggregation at 10k entries stays in budget', async () => {
    const matches = {};
    for (let i = 0; i < 10000; i++) {
      matches[`p${i % 5}::k${i}`] = {
        jobId: `k${i}`, profileId: `p${i % 5}`, score: 60 + (i % 40),
        outcome: ['surfaced', 'viewed', 'saved', 'rejected', 'applied'][i % 5],
        matchedSignals: ['python', 'aws'],
      };
    }
    const t0 = Date.now();
    const m = computeOutcomeMetrics({ matches });
    const q = computeSearchQuality({
      records: Object.keys(matches).slice(0, 2000).map((k, i) => ({ jobId: `k${i}`, sources: ['stub-a'] })),
      historyEntries: Object.values(matches).slice(0, 2000),
    });
    const dt = Date.now() - t0;
    assert.equal(m.scored, 10000);
    assert.ok(q.sample.count === 2000);
    console.log(`      10k outcome + 2k quality aggregation: ${dt}ms`);
    assert.ok(dt < 30000, 'aggregation budget exceeded');
  });
});
