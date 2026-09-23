// Explanation-integrity tests: real scorer output must audit clean;
// fabricated fragments must be caught; the auditor is deterministic.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchJob } from '../lib/matcher.mjs';
import { auditMatchExplanation } from '../lib/explanation-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const loadProfiles = () => readdirSync(join(HERE, 'fixtures', 'eval-profiles'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'eval-profiles', f), 'utf8')));

const JOB = {
  title: 'Senior Backend Engineer',
  company: 'Acme',
  location: 'Austin, TX',
  country: 'US',
  description: 'Senior backend engineer. Python, PostgreSQL, Kubernetes on AWS. Full-time, remote-friendly.',
  sources: ['stub-a'],
  employmentType: 'full-time',
  salary: { min: 150000, max: 180000, currency: 'USD' },
};

describe('explanation audit on real scorer output', () => {
  it('every eval profile × sample jobs audits clean', () => {
    const profiles = loadProfiles();
    const jobs = [
      JOB,
      { ...JOB, title: 'VP People', company: '', description: 'Talent strategy, succession planning, HR analytics. Executive scope.' },
      { ...JOB, title: 'Junior Web Developer', company: 'Beta', description: 'Entry-level HTML and CSS.' },
      { ...JOB, title: 'Account Executive', description: 'B2B sales prospecting and negotiation. Salesforce.' },
    ];
    let checked = 0;
    for (const p of profiles) {
      for (const job of jobs) {
        const m = matchJob(job, p.profile, { jobId: 'eval', profileId: p.id, now: 0 });
        const { checked: n, violations } = auditMatchExplanation({ match: m, job, profile: p.profile });
        checked += n;
        assert.deepEqual(violations, [], `${p.id} × "${job.title}": ${JSON.stringify(violations).slice(0, 300)}`);
      }
    }
    assert.ok(checked > 40, `expected broad coverage, checked ${checked}`);
  });

  it('is deterministic', () => {
    const profiles = loadProfiles();
    const m = matchJob(JOB, profiles[0].profile, { jobId: 'x', profileId: 'y', now: 0 });
    const a = auditMatchExplanation({ match: m, job: JOB, profile: profiles[0].profile });
    const b = auditMatchExplanation({ match: m, job: JOB, profile: profiles[0].profile });
    assert.deepEqual(a, b);
  });
});

describe('explanation audit catches fabrication', () => {
  const profile = loadProfiles().find((p) => p.id === 'eval-software-eng').profile; // 7 yoe, Python

  it('flags a skill the profile does not have', () => {
    const { violations } = auditMatchExplanation({
      match: { reasons: ['Skill match: COBOL, Python'], penalties: [] },
      job: JOB, profile,
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].code, 'FRAGMENT_NOT_IN_PROFILE');
  });

  it('flags invented years of experience', () => {
    const { violations } = auditMatchExplanation({
      match: { reasons: ['10 years experience fits scope'], penalties: [] },
      job: JOB, profile,
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0].detail, /7/);
  });

  it('flags a company that is not the employer', () => {
    const { violations } = auditMatchExplanation({
      match: { reasons: ['Identified employer: Initech'], penalties: [] },
      job: JOB, profile,
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].code, 'FRAGMENT_NOT_IN_JOB');
  });

  it('flags unknown templates (drift guard)', () => {
    const { violations } = auditMatchExplanation({
      match: { reasons: ['Great vibes and culture fit'], penalties: ['Questionable aura'] },
      job: JOB, profile,
    });
    assert.equal(violations.length, 2);
    assert.ok(violations.every((v) => v.code === 'UNKNOWN_TEMPLATE'));
  });

  it('flags non-profile signals', () => {
    const { violations } = auditMatchExplanation({
      match: { reasons: [], penalties: [], matchedSignals: ['telepathy'], missingSignals: [] },
      job: JOB, profile,
    });
    assert.equal(violations.length, 1);
  });
});
