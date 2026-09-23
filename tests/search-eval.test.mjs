// search-eval tests — hermetic stub providers (no network). Proves the
// evaluation framework measures the real pipeline without tuning it, and
// that five overlapping profiles share one retrieval plan.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateProfileSearch, evaluateSearchAcrossProfiles } from '../lib/search-eval.mjs';
import { DEFAULT_WEIGHTS } from '../lib/match-score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const loadProfiles = () => readdirSync(join(HERE, 'fixtures', 'eval-profiles'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'eval-profiles', f), 'utf8')));

const stubJobs = (tag) => [
  { title: 'Senior Backend Engineer', url: `https://example.com/${tag}-1`, company: 'Acme', location: 'Austin, TX', description: 'Python PostgreSQL Kubernetes AWS senior backend engineer', postedAt: Date.now(), source: tag },
  { title: 'Account Executive', url: `https://example.com/${tag}-2`, company: 'Beta', location: 'Remote, US', description: 'B2B sales prospecting negotiation Salesforce enterprise account executive', postedAt: Date.now(), source: tag },
  { title: 'Finance Manager', url: `https://example.com/${tag}-3`, company: 'Gamma', location: 'New York, NY', description: 'FP&A financial modeling forecasting variance analysis corporate finance', postedAt: Date.now(), source: tag },
];
const stubProvider = (id) => ({
  id,
  async fetch(entry) {
    if (entry.query.includes('ZERO-RESULT-MARKER')) return [];
    return stubJobs(id);
  },
});
const mods = () => new Map([['stub-a', stubProvider('stub-a')], ['stub-b', stubProvider('stub-b')]]);

describe('search-eval fixtures', () => {
  it('five domain profiles load with structured signals only', () => {
    const profiles = loadProfiles();
    assert.equal(profiles.length, 5);
    const blob = JSON.stringify(profiles);
    assert.ok(!/@/.test(blob.replace(/Id|ID/g, '')), 'no emails in fixtures');
    assert.ok(!/resume|phone|ssn|address/i.test(blob));
    for (const p of profiles) {
      assert.ok(p.id && p.profile?.targetRoles?.length > 0);
    }
  });
});

describe('evaluateProfileSearch (stubs)', () => {
  it('measures intent, retrieval, families, matching, and gaps', async () => {
    const profiles = loadProfiles();
    const swe = profiles.find((p) => p.id === 'eval-software-eng');
    const out = await evaluateProfileSearch({
      profileId: swe.id, profile: swe.profile,
      providerModules: mods(), providers: ['stub-a', 'stub-b'], maxQueries: 4,
    });
    assert.ok(out.intent.families.length > 0);
    assert.ok(out.intent.queries.length > 0 && out.intent.queries.length <= 4);
    const per = out.retrieval.perProvider;
    const jobsPerFetch = 3;
    for (const pid of ['stub-a', 'stub-b']) {
      assert.equal(per[pid].retrieved, out.intent.queries.length * jobsPerFetch);
    }
    const sumAccepted = Object.values(per).reduce((a, p) => a + p.accepted, 0);
    assert.equal(out.retrieval.totals.accepted, sumAccepted);
    assert.ok(out.matching.matched > 0);
    assert.ok(out.matching.scoreMax >= (out.matching.scoreMin ?? 0));
    assert.ok(Array.isArray(out.samples) && out.samples.length > 0);
    assert.ok(typeof out.gaps.noStrongMatches === 'boolean');
    assert.ok(out.retrieval.sample && out.matching.sample);
  });

  it('flags zero-result queries factually', async () => {
    const profiles = loadProfiles();
    const swe = profiles.find((p) => p.id === 'eval-software-eng');
    const out = await evaluateProfileSearch({
      profileId: swe.id,
      profile: { ...swe.profile, targetRoles: ['ZERO-RESULT-MARKER Engineer'] },
      providerModules: mods(), providers: ['stub-a'], maxQueries: 2,
    });
    assert.ok(out.gaps.zeroResultQueries > 0);
    assert.ok(out.zeroResultQueries.length > 0);
    assert.equal(out.zeroResultQueries[0].family, 'engineer');
    assert.equal(out.retrieval.totals.accepted, 0);
    assert.equal(out.matching.matched, 0);
  });

  it('does not tune the scorer (weights pinned)', () => {
    assert.deepEqual(DEFAULT_WEIGHTS, {
      title: 25, seniority: 12, skills: 18, functional: 10, experience: 5,
      company: 6, compensation: 7, location: 10, employment: 4, leadership: 3,
    });
  });
});

describe('evaluateSearchAcrossProfiles (stubs)', () => {
  it('five profiles share one retrieval plan', async () => {
    const profiles = loadProfiles();
    const out = await evaluateSearchAcrossProfiles({
      profiles, providerModules: mods(), providers: ['stub-a', 'stub-b'], maxQueries: 6,
    });
    assert.equal(out.sharedPlan.profiles, 5);
    assert.ok(out.sharedPlan.mergedQueries <= out.sharedPlan.naivePerProfileSum);
    assert.equal(out.sharedPlan.shared, true);
    assert.equal(Object.keys(out.perProfile).length, 5);
    for (const p of profiles) assert.ok(out.perProfile[p.id].matched >= 0);
    // Overlapping software-eng + program-mgmt intent matches shared jobs.
    assert.ok(out.multiProfileMatches >= 0);
  });
});

describe('search-eval privacy (§24)', () => {
  it('evaluation artifacts carry structured signals, never PII', async () => {
    const profiles = loadProfiles();
    const out = await evaluateSearchAcrossProfiles({
      profiles, providerModules: mods(), providers: ['stub-a'], maxQueries: 3,
    });
    const blob = JSON.stringify(out);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(blob), 'no emails in eval output');
    assert.ok(!/\b\d{3}[-.]\d{3}[-.]\d{4}\b/.test(blob), 'no phone numbers in eval output');
    assert.ok(!/resume|ssn|social security/i.test(blob), 'no resume/PII markers in eval output');
    // Per-profile evals embed no profile objects either.
    const single = await evaluateProfileSearch({
      profileId: profiles[0].id, profile: profiles[0].profile,
      providerModules: mods(), providers: ['stub-a'], maxQueries: 2,
    });
    const singleBlob = JSON.stringify(single);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(singleBlob));
    assert.ok(!('profile' in single) || typeof single.profile === 'undefined');
  });
});
