// Match-evaluation performance (local, deterministic, network-free).
// Diagnostics must stay cheap at 10k scale.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseMatch, bandDistribution } from '../lib/match-diagnostics.mjs';
import { evaluateMatchCase, summarizeEvalSet, classifyRetrievalStatus } from '../lib/match-eval.mjs';

const JOB = (i) => ({
  title: `Engineer ${i}`, company: `Acme${i % 50}`, location: 'Austin, TX', country: 'US',
  description: `Python systems engineering role number ${i}. Full-time.`,
  sources: ['eval'], employmentType: 'full-time', url: `https://example.com/${i}`,
});
const PROFILE = {
  targetRoles: ['Software Engineer'], currentRoles: [], seniority: 'senior',
  skills: ['Python', 'AWS'], technologies: [], domains: [], industries: [],
  functionalAreas: ['engineering'], leadershipSignals: [], yearsExperience: 6,
  workplacePrefs: [], employmentPrefs: [], compensationPrefs: {}, exclusions: [],
};

describe('match-eval performance (local)', () => {
  for (const n of [1000, 10000]) {
    it(`diagnostics for ${n} jobs stay in budget`, async () => {
      const t0 = Date.now();
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = diagnoseMatch({ job: JOB(i), profile: PROFILE, now: 0 });
        sum += d.score;
      }
      const dt = Date.now() - t0;
      assert.ok(sum > 0);
      console.log(`      ${n} diagnostics: ${dt}ms`);
      assert.ok(dt < (n === 1000 ? 15000 : 120000), `diagnostic budget exceeded at ${n}`);
    });
  }

  it('5-profile match evaluation stays in budget', async () => {
    const t0 = Date.now();
    const results = [];
    for (let p = 0; p < 5; p++) {
      for (let i = 0; i < 200; i++) {
        results.push(evaluateMatchCase({ id: `c${p}-${i}`, profileId: `p${p}`, profile: PROFILE, job: JOB(i), expected: { relevance: 'UNCLEAR' }, now: 0 }));
      }
    }
    const summary = summarizeEvalSet(results);
    const dt = Date.now() - t0;
    assert.equal(results.length, 1000);
    assert.equal(summary.matrix.UNCLEAR.count, 1000);
    console.log(`      5-profile × 200-case evaluation + report: ${dt}ms`);
    assert.ok(dt < 60000, 'evaluation budget exceeded');
  });

  it('retrieval-miss classification at 10k stays in budget', async () => {
    const t0 = Date.now();
    const counts = {};
    for (let i = 0; i < 10000; i++) {
      const s = classifyRetrievalStatus({
        inRaw: true, normalized: i % 10 !== 0, usAccepted: i % 20 !== 0,
        fresh: true, canonical: true, matchedBest: 40 + (i % 50),
      });
      counts[s] = (counts[s] || 0) + 1;
    }
    const dt = Date.now() - t0;
    assert.ok(counts.MATCHED_HIGH > 0 && counts.FILTERED_TITLE > 0);
    console.log(`      10k retrieval classifications: ${dt}ms`);
    assert.ok(dt < 5000, 'classification budget exceeded');
  });

  it('band distribution at 10k stays in budget', async () => {
    const matches = [];
    for (let i = 0; i < 10000; i++) matches.push({ score: (i * 37) % 101 });
    const t0 = Date.now();
    const dist = bandDistribution(matches);
    const dt = Date.now() - t0;
    assert.equal(dist.count, 10000);
    console.log(`      10k band distribution: ${dt}ms`);
    assert.ok(dt < 5000, 'distribution budget exceeded');
  });
});
