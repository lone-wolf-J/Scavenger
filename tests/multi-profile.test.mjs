import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchJobMany, matchPool } from '../lib/matcher.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';

const PROFILES = JSON.parse(readFileSync(new URL('./fixtures/test-profiles.json', import.meta.url), 'utf-8'));
const profs = (names) => names.map((n) => ({ id: n, profile: normalizeCareerProfile(PROFILES[n]) }));

describe('multi-profile matching', () => {
  const job = {
    title: 'Director of AI Transformation', company: 'Vertex', location: 'Remote - US',
    country: 'US', url: 'https://v/1', source: 'linkedin',
    description: 'Enterprise AI transformation; LLM platform; P&L ownership; consulting with clients',
  };
  it('one job, many profiles: displayed once with per-profile scores', () => {
    const agg = matchJobMany(job, [
      ...profs(['hr-director']),
      ...profs(['ai-leadership']),
      { id: 'consulting', profile: normalizeCareerProfile({ targetRoles: ['AI Consultant', 'Transformation Consultant'], seniority: 'director', skills: ['enterprise AI', 'consulting'], functionalAreas: ['consulting'] }) },
    ]);
    assert.ok(agg.jobId);
    assert.equal(agg.matches.length, 3);
    const byId = Object.fromEntries(agg.matches.map((m) => [m.profileId, m.score]));
    assert.ok(byId['ai-leadership'] >= 85, `ai=${byId['ai-leadership']}`);
    assert.ok(byId['hr-director'] < 60, `hr=${byId['hr-director']}`);
    assert.ok(byId['consulting'] > byId['hr-director']);
    assert.equal(agg.best.profileId, 'ai-leadership');
    assert.ok(agg.best.reasons.length > 0);
  });
  it('pool aggregation sorts by best score and drops below minScore', () => {
    const jobs = [
      job,
      { title: 'Dental Hygienist', company: 'Smile', location: 'Austin, TX', country: 'US', url: 'https://s/9', source: 'dice', description: 'clinical care' },
    ];
    const all = matchPool(jobs, profs(['ai-leadership', 'hr-director']));
    assert.equal(all.length, 2);
    assert.ok(all[0].best.score >= all[1].best.score);
    const filtered = matchPool(jobs, profs(['ai-leadership', 'hr-director']), { minScore: 60 });
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].best.score >= 60);
  });
  it('empty inputs never throw', () => {
    assert.deepEqual(matchJobMany(job, []).matches, []);
    assert.deepEqual(matchPool([], profs(['hr-director'])), []);
    assert.deepEqual(matchPool(null, null), []);
  });
});
