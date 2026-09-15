import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEmployer, aggregateDiscovery, mergeReviewQueue } from '../lib/employer-discovery.mjs';

describe('employer-discovery', () => {
  it('rejects board-as-employer, generic names, and missing companies', () => {
    for (const name of ['Dice', 'Dice Employer', 'LinkedIn Jobs', 'Confidential', 'Stealth Startup', '']) {
      const d = scoreEmployer({ company: name, location: 'Austin, TX' });
      assert.equal(d.tier, 'low', name);
      assert.ok(d.rejectReason, name);
    }
  });

  it('scores a US employer with career URL as high confidence', () => {
    const d = scoreEmployer(
      { company: 'Example AI', location: 'Austin, TX', sourceCompanyUrl: 'https://example.ai/careers' },
      { sources: ['dice'] },
    );
    assert.equal(d.tier, 'high');
    assert.ok(d.confidence >= 0.8);
    assert.ok(d.evidence.some((e) => /US location/.test(e)));
    assert.ok(d.evidence.some((e) => /career URL/.test(e)));
  });

  it('puts a plain US employer (no career URL) in the review queue', () => {
    const d = scoreEmployer({ company: 'Example AI', location: 'Remote - US' });
    assert.equal(d.tier, 'medium');
  });

  it('caps staffing intermediaries at medium even with strong evidence', () => {
    const d = scoreEmployer(
      { company: 'TekSystems Staffing', location: 'Austin, TX', sourceCompanyUrl: 'https://teksystems.com/jobs' },
      { sources: ['dice', 'indeed'] },
    );
    assert.equal(d.tier, 'medium');
    assert.ok(d.confidence < 0.8);
  });

  it('rejects non-US employers', () => {
    const d = scoreEmployer({ company: 'Acme Ltd', location: 'London, UK' });
    assert.equal(d.tier, 'low');
    assert.equal(d.rejectReason, 'non-us-employer');
  });

  it('aggregates jobs, dedups aliases, skips tracked companies', () => {
    const jobs = [
      { company: 'Acme Inc.', location: 'Austin, TX', url: 'https://a/1', _discoverySource: 'dice' },
      { company: 'ACME', location: 'Austin, TX', url: 'https://b/2', _discoverySource: 'indeed' },
      { company: 'Dice', location: 'Austin, TX', url: 'https://d/3', _discoverySource: 'dice' },
      { company: 'TrackedCo LLC', location: 'Austin, TX', url: 'https://t/4', _discoverySource: 'dice' },
    ];
    const agg = aggregateDiscovery(jobs, { trackedKeys: new Set(['trackedco']) });
    // Acme aliases merge into one decision; Dice rejected; TrackedCo skipped.
    const acme = agg.decisions.find((d) => d.key === 'acme');
    assert.ok(acme);
    assert.equal(acme.jobCount, 2);
    assert.deepEqual(acme.sources.sort(), ['dice', 'indeed']);
    assert.ok(agg.low.some((d) => d.rejectReason === 'board-as-employer'));
    assert.equal(agg.existing, 1);
  });

  it('merges review queue without losing status', () => {
    const now = new Date().toISOString();
    const q1 = mergeReviewQueue([], [{ key: 'acme', name: 'Acme', confidence: 0.7, tier: 'medium', evidence: ['a'], sources: ['dice'], jobCount: 1, exampleJobUrl: '', exampleLocation: '' }], now);
    assert.equal(q1.length, 1);
    assert.equal(q1[0].status, 'pending');
    q1[0].status = 'approved';
    const q2 = mergeReviewQueue(q1, [{ key: 'acme', name: 'Acme', confidence: 0.75, tier: 'medium', evidence: ['b'], sources: ['indeed'], jobCount: 2, exampleJobUrl: '', exampleLocation: '' }], now);
    assert.equal(q2.length, 1);
    assert.equal(q2[0].status, 'approved');
    assert.equal(q2[0].jobCount, 3);
    assert.ok(q2[0].evidence.includes('a') && q2[0].evidence.includes('b'));
  });
});
