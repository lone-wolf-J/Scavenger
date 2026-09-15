import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreJob } from '../lib/match-score.mjs';
import { canonicalJobKey, normalizeJobUrl, mergeIntoCanonical } from '../lib/job-dedup.mjs';

describe('match-score', () => {
  const profile = {
    targetRoles: ['Content Marketing Specialist', 'SEO Content Strategist', 'B2B Content Marketing Manager'],
    seniority: 'senior',
    compensation: { min: 80000 },
    exclusions: ['junior', 'intern'],
  };
  it('scores a strong match high with reasons', () => {
    const r = scoreJob({
      title: 'Senior Content Marketing Manager',
      company: 'Acme',
      location: 'Remote - US',
      country: 'US',
      description: 'SEO and content strategy for B2B',
      employmentType: 'full-time',
      salary: { min: 100000, max: 130000, currency: 'USD' },
    }, profile);
    assert.ok(r.score >= 70, `score ${r.score}`);
    assert.ok(r.reasons.length > 0);
    assert.ok(r.reasons.some((x) => /US remote/i.test(x)));
  });
  it('penalizes weak titles, low pay, contracts — with explanations', () => {
    const r = scoreJob({ title: 'Contract Junior Copywriter', location: 'Remote', salary: { min: 30000 } }, profile);
    assert.ok(r.score < 50, `score ${r.score}`);
    assert.ok(r.penalties.some((x) => /contract position/i.test(x)));
    assert.ok(r.penalties.some((x) => /compensation/.test(x)));
  });
  it('vetoes exclusions with a cap and never returns a bare score', () => {
    const r = scoreJob({ title: 'Junior Content Intern', location: 'Austin, TX', country: 'US' }, profile);
    assert.ok(r.score <= 20);
    assert.ok(r.penalties.some((x) => /Exclusion/.test(x)));
    assert.ok(Array.isArray(r.reasons) && typeof r.breakdown === 'object');
  });
});

describe('job-dedup', () => {
  it('resolves one role across LinkedIn, Dice, and career site', () => {
    const store = new Map();
    const base = { title: 'AI Solutions Architect', company: 'Microsoft', location: 'Remote - US', postedAt: Date.parse('2026-09-10') };
    const r1 = mergeIntoCanonical(store, { ...base, url: 'https://linkedin.com/jobs/view/1', source: 'linkedin' });
    const r2 = mergeIntoCanonical(store, { ...base, url: 'https://dice.com/job-detail/x', source: 'dice' });
    const r3 = mergeIntoCanonical(store, { ...base, url: 'https://careers.microsoft.com/y', source: 'greenhouse' });
    assert.equal(r1.isNew, true);
    assert.equal(r2.isNew, false);
    assert.equal(r3.isNew, false);
    assert.deepEqual(r3.opportunity.sources.sort(), ['dice', 'greenhouse', 'linkedin']);
    assert.equal(store.size, 1);
  });
  it('keeps distinct roles, companies, and dates apart', () => {
    assert.notEqual(
      canonicalJobKey({ title: 'AI Engineer', company: 'Acme', location: 'Austin, TX' }),
      canonicalJobKey({ title: 'ML Engineer', company: 'Acme', location: 'Austin, TX' }),
    );
    assert.notEqual(
      canonicalJobKey({ title: 'AI Engineer', company: 'Acme', location: 'Austin, TX' }),
      canonicalJobKey({ title: 'AI Engineer', company: 'Beta', location: 'Austin, TX' }),
    );
  });
  it('normalizes tracking params out of URLs', () => {
    assert.equal(
      normalizeJobUrl('https://x.com/j/1?utm_source=y&ref=z#frag'),
      normalizeJobUrl('https://x.com/j/1'),
    );
  });
});

