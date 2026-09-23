// match-eval + diagnostics tests — fixtures only, no network.
// Pins framework behavior; case scores are asserted as bands/ranges where
// the framework must be robust, and exactly where the diagnostic contract
// requires it (contribution sums, determinism).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseMatch, bandDistribution } from '../lib/match-diagnostics.mjs';
import {
  evaluateMatchCase, isFalseNegative, isFalsePositive, attributeShortfall,
  classifyRetrievalStatus, diagnoseIntent, summarizeEvalSet, DEFAULT_WEIGHTS,
} from '../lib/match-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const loadCases = () => JSON.parse(readFileSync(join(HERE, 'fixtures', 'match-eval-cases.json'), 'utf8')).cases;
const loadProfiles = () => Object.fromEntries(readdirSync(join(HERE, 'fixtures', 'eval-profiles'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => { const p = JSON.parse(readFileSync(join(HERE, 'fixtures', 'eval-profiles', f), 'utf8')); return [p.id, p.profile]; }));

const evalAll = () => {
  const profiles = loadProfiles();
  return loadCases().map((c) => evaluateMatchCase({
    id: c.id, profileId: c.profileId, profile: profiles[c.profileId], job: c.job, expected: c.expected,
  }));
};

describe('match diagnostics', () => {
  it('contributions reconstruct the score from the real scorer', () => {
    const profiles = loadProfiles();
    const cases = loadCases();
    for (const c of cases) {
      const d = diagnoseMatch({ job: c.job, profile: profiles[c.profileId] });
      const sum = Object.values(d.breakdown).reduce((a, b) => a + b, 0);
      const vetoed = d.penalties.includes('Capped: exclusion veto');
      assert.equal(d.score, vetoed ? Math.min(sum, 20) : Math.max(0, Math.min(100, Math.round(sum))), c.id);
      assert.equal(d.positiveContributors.reduce((a, x) => a + x.points, 0), sum, `${c.id}: positives sum`);
      for (const key of Object.keys(DEFAULT_WEIGHTS)) {
        assert.ok(key in d.breakdown, `${c.id}: breakdown missing ${key}`);
      }
    }
  });

  it('is deterministic', () => {
    const profiles = loadProfiles();
    const c = loadCases()[0];
    const a = diagnoseMatch({ job: c.job, profile: profiles[c.profileId] });
    const b = diagnoseMatch({ job: c.job, profile: profiles[c.profileId] });
    assert.deepEqual(a, b);
  });

  it('band distribution buckets without judging thresholds', () => {
    const dist = bandDistribution(evalAll());
    assert.equal(dist.count, 14);
    assert.equal(dist.buckets['0-24'], 1); // junior veto cap
    assert.equal(dist.buckets['75-100'], 6); // clear/plausible matches + the Berlin case (retrieval, not match, owns geography)
    assert.ok(dist.average >= 50 && dist.average <= 80);
    assert.ok(dist.median >= 50 && dist.median <= 80);
  });
});

describe('eval-set investigation', () => {
  it('labels are categorical, never scores or ranks', () => {
    for (const c of loadCases()) {
      assert.ok(['CLEAR_MATCH', 'PLAUSIBLE_MATCH', 'UNCLEAR', 'CLEAR_MISMATCH'].includes(c.expected.relevance));
      assert.ok(!('score' in c.expected) && !('grade' in c.expected));
    }
    assert.equal(loadCases().length, 14);
  });

  it('finds the known false negative and no false positives', () => {
    const summary = summarizeEvalSet(evalAll());
    assert.equal(summary.matrix.CLEAR_MATCH.count, 5);
    assert.equal(summary.matrix.CLEAR_MISMATCH.count, 2);
    assert.deepEqual(summary.falseNegatives.map((f) => f.id), ['hr-role-variant']);
    assert.deepEqual(summary.falsePositives, []);
    // Mismatches stay low.
    assert.ok(summary.matrix.CLEAR_MISMATCH.avgScore < 50);
  });

  it('attributes shortfalls to causes without tuning', () => {
    const summary = summarizeEvalSet(evalAll());
    assert.ok(summary.causes['C: missing evidence'] >= 1);
    // Attribution never emits weights, thresholds, or adjustments.
    assert.ok(!('weights' in summary) && !('adjustments' in summary));
  });

  it('false-negative detail carries expected vs actual', () => {
    const results = evalAll();
    const fn = results.find((r) => r.id === 'hr-role-variant');
    assert.equal(isFalseNegative(fn), true);
    assert.equal(fn.expected.seniority, 'head');
    assert.equal(fn.diagnostic.seniorityAssessment.jobLevel, 'head');
    assert.equal(fn.diagnostic.seniorityAssessment.profileLevel, 'executive');
    assert.ok(fn.penalties.some((p) => p.includes('Below profile seniority')));
  });
});

describe('retrieval-miss classification', () => {
  it('walks the funnel stages in order', () => {
    assert.equal(classifyRetrievalStatus({}), 'NOT_RETRIEVED');
    assert.equal(classifyRetrievalStatus({ inRaw: true }), 'FILTERED_TITLE');
    assert.equal(classifyRetrievalStatus({ inRaw: true, normalized: true }), 'FILTERED_LOCATION');
    assert.equal(classifyRetrievalStatus({ inRaw: true, normalized: true, usAccepted: true }), 'FILTERED_FRESHNESS');
    assert.equal(classifyRetrievalStatus({ inRaw: true, normalized: true, usAccepted: true, fresh: true }), 'DUPLICATED');
    assert.equal(classifyRetrievalStatus({ inRaw: true, normalized: true, usAccepted: true, fresh: true, canonical: true }), 'MATCHED_LOW');
    assert.equal(classifyRetrievalStatus({ inRaw: true, normalized: true, usAccepted: true, fresh: true, canonical: true, matchedBest: 80 }), 'MATCHED_HIGH');
    assert.equal(classifyRetrievalStatus({ inRaw: true, normalized: true, usAccepted: true, fresh: true, canonical: true, matchedBest: 60 }), 'MATCHED_LOW');
  });

  it('a non-US job is a retrieval matter, never a matcher failure', () => {
    const results = evalAll();
    const berlin = results.find((r) => r.id === 'sales-unclear-berlin');
    // Matcher scores the text it sees; geography is the pipeline US gate's job.
    assert.ok(berlin.score >= 75);
    assert.equal(classifyRetrievalStatus({ inRaw: true, normalized: true, usAccepted: false }), 'FILTERED_LOCATION');
  });
});

describe('intent diagnostics', () => {
  it('exposes families/queries and plausible-query hypotheses', () => {
    const profiles = loadProfiles();
    const d = diagnoseIntent({
      profileId: 'eval-software-eng', profile: profiles['eval-software-eng'],
      jobs: [{ jobId: 'j1', title: 'Senior Backend Engineer', company: 'Acme' }, { jobId: 'j2', title: 'Staff Nurse', company: 'Kappa' }],
    });
    assert.ok(d.families.includes('engineer'));
    assert.ok(d.queries.length > 0);
    const j1 = d.perJob.find((x) => x.jobId === 'j1');
    const j2 = d.perJob.find((x) => x.jobId === 'j2');
    assert.ok(j1.plausibleQueries.length > 0);
    assert.equal(j2.plausibleQueries.length, 0);
  });
});
