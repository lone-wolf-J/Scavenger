// Profile-generality tests (Phase 10 §16): Scavenger must not become
// accidentally optimized around development profiles. Evaluation profiles
// span five domains; parsing, families, seniority, intent, and matching must
// behave generically, and the scorer must carry no domain-specific constants.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { clusterRolesToFamilies, generateSearchFamilies, familyQuery } from '../lib/search-generation.mjs';
import { buildSearchIntent } from '../lib/search-intent.mjs';
import { matchJob } from '../lib/matcher.mjs';
import { seniorityOf } from '../lib/match-score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const loadProfiles = () => readdirSync(join(HERE, 'fixtures', 'eval-profiles'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'eval-profiles', f), 'utf8')));

describe('profile generality', () => {
  it('profile parsing is generic across domains', () => {
    for (const p of loadProfiles()) {
      const norm = normalizeCareerProfile(p.profile);
      assert.deepEqual(norm.targetRoles, p.profile.targetRoles);
      assert.equal(norm.seniority, p.profile.seniority);
      assert.ok(norm.skills.length > 0);
    }
  });

  it('family names derive from input roles, never a domain list', () => {
    for (const p of loadProfiles()) {
      const fams = clusterRolesToFamilies(p.profile.targetRoles, p.profile.seniority);
      assert.ok(fams.length > 0);
      for (const f of fams) {
        const heads = p.profile.targetRoles.map((r) => String(r).toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean).pop());
        assert.ok(heads.includes(f.name) || f.name === 'general', `${p.id}: family "${f.name}" not derived from roles`);
      }
    }
  });

  it('seniority classification is generic vocabulary', () => {
    assert.equal(seniorityOf('VP People'), 'vp');
    assert.equal(seniorityOf('Head of Talent'), 'head');
    assert.equal(seniorityOf('FP&A Manager'), 'manager');
    assert.equal(seniorityOf('Account Executive'), 'mid');
    assert.equal(seniorityOf('Barista'), 'mid'); // unknown words default, never crash
  });

  it('search intent builds for every domain without tuning', () => {
    for (const p of loadProfiles()) {
      const intent = buildSearchIntent([{ id: p.id, profile: p.profile }]);
      assert.ok(intent.queries.length > 0, `${p.id}: no queries`);
      assert.ok(intent.queries.every((q) => q.length <= 200));
    }
  });

  it('matching scores every domain × job combination in range', () => {
    const profiles = loadProfiles();
    const jobs = [
      { title: 'Senior Backend Engineer', company: 'A', location: 'Austin, TX', description: 'Python systems', sources: ['s'] },
      { title: 'VP People', company: 'B', location: 'Remote, US', description: 'talent strategy executive', sources: ['s'] },
      { title: 'FP&A Manager', company: 'C', location: 'New York, NY', description: 'financial modeling forecast', sources: ['s'] },
    ];
    for (const p of profiles) {
      for (const job of jobs) {
        const m = matchJob(job, p.profile, { jobId: 'j', profileId: p.id, now: 0 });
        assert.ok(m.score >= 0 && m.score <= 100, `${p.id}: score out of range`);
        assert.ok(typeof m.band === 'object' && m.band.label);
      }
    }
    // Cross-domain sanity: software-eng outscores HR-leadership on the backend job.
    const swe = profiles.find((p) => p.id === 'eval-software-eng').profile;
    const hr = profiles.find((p) => p.id === 'eval-hr-leadership').profile;
    const be = jobs[0];
    assert.ok(matchJob(be, swe, { now: 0 }).score > matchJob(be, hr, { now: 0 }).score);
  });

  it('scorer carries no domain-specific role constants', () => {
    const src = readFileSync(join(HERE, '..', 'lib', 'match-score.mjs'), 'utf8');
    for (const word of ['nurse', 'accountant', 'teacher', 'lawyer', 'physician', 'surgeon', 'pharmacist', 'paralegal', 'underwriter', 'actuary', 'realtor', 'pastor', 'rabbi', 'imam', 'chef', 'pilot', 'electrician', 'plumber']) {
      assert.ok(!new RegExp(`['"\`]${word}['"\`]`, 'i').test(src), `domain literal "${word}" in scorer`);
    }
  });

  it('family queries render for every domain', () => {
    for (const p of loadProfiles()) {
      for (const f of generateSearchFamilies(p.profile)) {
        const q = familyQuery(f);
        assert.ok(q.length > 0 && q.length <= 200);
      }
    }
  });
});
