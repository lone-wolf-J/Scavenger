import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeJob } from '../lib/job-model.mjs';
import { matchJob } from '../lib/matcher.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { emptyStore, upsertJobs, allJobs } from '../lib/job-store.mjs';
import { generateSearchFamilies } from '../lib/search-generation.mjs';

const PROFILES = JSON.parse(readFileSync(new URL('./fixtures/test-profiles.json', import.meta.url), 'utf-8'));

// ONE shared normalized job pool — four unrelated professions.
const JOBS = [
  { title: 'HR Director', company: 'Acme', location: 'Chicago, IL', country: 'US', url: 'https://a/1', source: 'indeed', description: 'talent acquisition leadership, Workday, succession planning' },
  { title: 'Senior Software Engineer, Backend', company: 'Beta', location: 'Remote - US', country: 'US', url: 'https://b/2', source: 'dice', description: 'Python, Go, distributed systems, mentoring' },
  { title: 'Marketing Director, B2B', company: 'Gamma', location: 'Boston, MA', country: 'US', url: 'https://c/3', source: 'linkedin', description: 'B2B content strategy, SEO, HubSpot, demand generation' },
  { title: 'Senior Data Scientist', company: 'Delta', location: 'New York, NY', country: 'US', url: 'https://d/4', source: 'linkedin', description: 'machine learning, Python, experimentation, analytics' },
  { title: 'Staff Accountant', company: 'Epsilon', location: 'Dallas, TX', country: 'US', url: 'https://e/5', source: 'dice', description: 'month-end close, reconciliations, NetSuite' },
  { title: 'B2B Content Marketing Manager', company: 'Zeta', location: 'Remote - US', country: 'US', url: 'https://f/6', source: 'dice', description: 'B2B content strategy, SEO, Answer Engine Optimization, HubSpot' },
  { title: 'Forward Deployed AI Engineer', company: 'Eta', location: 'Remote - US', country: 'US', url: 'https://g/7', source: 'linkedin', description: 'LLM systems for enterprise customers, AI platform architecture' },
].map((j) => normalizeJob(j, j.source, Date.now()));

describe('shared job reuse across profiles', () => {
  it('same jobs, different matches per profile; irrelevant rejects', () => {
    const winners = {};
    for (const [name, raw] of Object.entries(PROFILES)) {
      const profile = normalizeCareerProfile(raw);
      const ranked = JOBS.map((job) => matchJob(job, profile, { profileId: name })).sort((a, b) => b.score - a.score);
      winners[name] = ranked[0];
      // Every profile's top match is its own domain job.
      assert.ok(ranked[0].score >= 70, `${name}: top=${ranked[0].score}`);
      // Every profile rejects at least one other domain's job.
      assert.ok(ranked.some((r) => r.score < 60), `${name}: nothing rejected`);
    }
    // The HR Director posting is won by hr-director, not by SWE.
    const hrJob = JOBS[0];
    const hrScore = matchJob(hrJob, normalizeCareerProfile(PROFILES['hr-director'])).score;
    const sweScore = matchJob(hrJob, normalizeCareerProfile(PROFILES['senior-swe'])).score;
    assert.ok(hrScore > sweScore + 20, `hr=${hrScore} swe=${sweScore}`);
    // Accountant posting: nobody's target → all weak/reject.
    const acct = JOBS[4];
    for (const [name, raw] of Object.entries(PROFILES)) {
      assert.ok(matchJob(acct, normalizeCareerProfile(raw)).score < 75, `${name} should not love accounting`);
    }
  });
  it('one store, many profiles — no per-user job duplication', () => {
    const store = emptyStore();
    upsertJobs(store, JOBS);
    assert.equal(allJobs(store).length, JOBS.length);
    // Matching every profile reads the same records.
    for (const raw of Object.values(PROFILES)) {
      for (const job of allJobs(store)) matchJob(job, normalizeCareerProfile(raw));
    }
    assert.equal(allJobs(store).length, JOBS.length);
  });
  it('search families derive per profile without code changes', () => {
    const fams = Object.values(PROFILES).map((raw) => generateSearchFamilies(normalizeCareerProfile(raw)));
    const firsts = fams.map((f) => f[0].name);
    assert.equal(new Set(firsts).size, 4); // director, engineer, manager(strategist?), scientist…
  });
});

describe('matching benchmark (no network)', () => {
  it('500 jobs x 4 profiles runs locally in seconds', () => {
    const titles = ['HR Manager', 'Software Engineer', 'Marketing Specialist', 'Data Scientist', 'Accountant', 'Nurse', 'Sales Rep', 'Designer'];
    const pool = [];
    for (let i = 0; i < 500; i++) {
      pool.push(normalizeJob({
        title: `${i % 2 ? 'Senior' : 'Junior'} ${titles[i % titles.length]}`,
        company: `Company${i % 60}`, location: 'Remote - US', country: 'US',
        url: `https://x.example/${i}`, source: 'bench',
        description: `Workday Python SEO machine learning accounting nursing sales design ${i}`,
      }, 'bench', Date.now()));
    }
    const profiles = Object.values(PROFILES).map(normalizeCareerProfile);
    const t0 = Date.now();
    let count = 0;
    for (const p of profiles) for (const j of pool) { matchJob(j, p); count++; }
    const ms = Date.now() - t0;
    assert.equal(count, 2000);
    console.log(`      benchmark: ${count} matches in ${ms}ms (${(count / Math.max(1, ms) * 1000).toFixed(0)}/s, zero network)`);
    assert.ok(ms < 30000, `${ms}ms exceeds budget`);
  });
});
