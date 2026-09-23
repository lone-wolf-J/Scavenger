// Match audits §12–14, §19–20: seniority steps, profile evidence,
// multi-profile detail, profile-specific outcomes. Fixtures only.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchJob, matchJobMany } from '../lib/matcher.mjs';
import { diagnoseMatch } from '../lib/match-diagnostics.mjs';
import { recordMatch, recordOutcome, markViewed } from '../lib/match-history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const loadProfiles = () => Object.fromEntries(readdirSync(join(HERE, 'fixtures', 'eval-profiles'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => { const p = JSON.parse(readFileSync(join(HERE, 'fixtures', 'eval-profiles', f), 'utf8')); return [p.id, p.profile]; }));

const SWE_JOB = {
  title: 'Senior Backend Engineer', company: 'Acme', location: 'Austin, TX', country: 'US',
  description: 'Senior backend engineer. Python, PostgreSQL, Kubernetes on AWS. Full-time.',
  sources: ['eval'], employmentType: 'full-time', url: 'https://example.com/j1',
};

describe('seniority audit (§12)', () => {
  it('one-step-up is a measured gap, not a veto', () => {
    const profiles = loadProfiles();
    const d = diagnoseMatch({
      job: { ...SWE_JOB, title: 'Principal Backend Engineer' },
      profile: profiles['eval-software-eng'],
    });
    assert.equal(d.seniorityAssessment.jobLevel, 'principal');
    assert.equal(d.seniorityAssessment.profileLevel, 'senior');
    assert.ok(d.seniorityAssessment.points < d.seniorityAssessment.max);
    assert.ok(!d.penalties.includes('Capped: exclusion veto'));
    assert.ok(d.score > 20, 'adjacent seniority never veto-caps');
  });

  it('adjacent tracks report distance symmetrically (observation, not tuning)', () => {
    const profiles = loadProfiles();
    const mgr = diagnoseMatch({ job: { ...SWE_JOB, title: 'Engineering Manager' }, profile: profiles['eval-software-eng'] });
    const sr = diagnoseMatch({ job: SWE_JOB, profile: profiles['eval-software-eng'] });
    // Manager-track title sits above senior on the single ladder: fewer points.
    assert.ok(mgr.seniorityAssessment.points <= sr.seniorityAssessment.points);
  });
});

describe('profile-evidence audit (§14)', () => {
  it('missingEvidence names unevidenced profile terms', () => {
    const profiles = loadProfiles();
    const d = diagnoseMatch({ job: SWE_JOB, profile: profiles['eval-software-eng'] });
    assert.ok(d.missingEvidence.some((m) => m.includes('Docker')), 'Docker absent from job is reported');
    assert.ok(!d.missingEvidence.some((m) => m.includes('"Python"')), 'Python present in job is not reported missing');
  });

  it('empty profile evidence is reported, not silently scored', () => {
    const d = diagnoseMatch({ job: SWE_JOB, profile: { targetRoles: ['Engineer'], seniority: 'senior' } });
    assert.ok(d.missingEvidence.some((m) => m.includes('no skills')));
  });
});

describe('multi-profile detail (§19)', () => {
  it('one job fans out to per-profile matches without duplicating the job', () => {
    const profiles = loadProfiles();
    const out = matchJobMany(SWE_JOB, [
      { id: 'eval-software-eng', profile: profiles['eval-software-eng'] },
      { id: 'eval-sales', profile: profiles['eval-sales'] },
    ], { now: 0 });
    assert.equal(out.matches.length, 2);
    assert.deepEqual(out.matches.map((m) => m.profileId).sort(), ['eval-sales', 'eval-software-eng']);
    assert.equal(out.matches[0].jobId, out.matches[1].jobId, 'one shared job identity');
    assert.ok(out.matches[0].score > out.matches[1].score);
    assert.ok(out.matches.every((m) => Array.isArray(m.reasons)));
  });
});

describe('profile-specific outcomes (§20)', () => {
  it('reject under B never touches A (key separation)', () => {
    const history = { version: 1, matches: {} };
    recordMatch(history, { jobId: 'j1', profileId: 'pa', result: matchJob(SWE_JOB, { targetRoles: ['Engineer'] }, {}), job: SWE_JOB, profile: {} });
    recordMatch(history, { jobId: 'j1', profileId: 'pb', result: matchJob(SWE_JOB, { targetRoles: ['Engineer'] }, {}), job: SWE_JOB, profile: {} });
    const saved = recordOutcome(history, { jobId: 'j1', profileId: 'pa', outcome: 'saved' });
    assert.equal(saved.ok, true);
    const viewed = markViewed(history, { jobId: 'j1', profileId: 'pb' });
    assert.ok(viewed);
    const rejected = recordOutcome(history, { jobId: 'j1', profileId: 'pb', outcome: 'rejected' });
    assert.equal(rejected.ok, true);
    assert.equal(history.matches['pa::j1'].outcome, 'saved');
    assert.equal(history.matches['pb::j1'].outcome, 'rejected');
  });
});
