import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReview, applyCorrections, confirmProfile } from '../lib/profile-review.mjs';
import { fromSignals } from '../lib/career-profile.mjs';
import { extractResumeSignals } from '../lib/resume-signals.mjs';
import { matchJob } from '../lib/matcher.mjs';
import { emptyStore, upsertJobs, getJob, allJobs } from '../lib/job-store.mjs';
import { emptyHistory, recordMatch, markViewed, recordOutcome, OUTCOMES } from '../lib/match-history.mjs';
import { redactForLogs } from '../profile.mjs';

const resume = (name) => readFileSync(new URL(`./fixtures/resumes/${name}.txt`, import.meta.url), 'utf-8');
const HR = fromSignals(extractResumeSignals(resume('hr-manager')));

describe('human review', () => {
  it('renders sections with status + evidence, inferred kept separate', () => {
    const { sections, text } = renderReview(HR, extractResumeSignals(resume('hr-manager')));
    assert.ok(sections.some((s) => s.field === 'seniority'));
    assert.ok(sections.every((s) => s.status === 'confirmed' || s.status === 'unconfirmed'));
    assert.ok(text.includes('[needs review]'));
    assert.ok(text.includes('Inferred target roles'));
  });
  it('"That\'s wrong" and "Add this" work; garbage is rejected, never applied', () => {
    const { profile, applied, rejected } = applyCorrections(HR, [
      { op: 'set', field: 'seniority', value: 'director' },
      { op: 'add', field: 'skills', value: 'Workday' }, // dup-safe
      { op: 'remove', field: 'targetRoles', value: 'HR Generalist' },
      { op: 'confirm', field: 'skills' },
      { op: 'set', field: 'nope', value: 'x' },
      { op: 'set', field: 'skills', value: 'x' },
      { op: 'frobnicate', field: 'skills', value: 'x' },
    ]);
    assert.equal(profile.seniority, 'director');
    assert.ok(profile.skills.includes('Workday'));
    assert.ok(!profile.targetRoles.includes('HR Generalist'));
    assert.equal(profile.reviewed.skills, true);
    assert.equal(rejected.length, 3);
    assert.ok(applied.length >= 4);
  });
  it('confirm adopts inferred targets only when asked', () => {
    const withInf = { ...HR, inferredTargets: [{ role: 'Staff HR Manager', confidence: 0.55, evidence: [] }] };
    const c1 = confirmProfile(withInf, { adoptInferred: ['Staff HR Manager'] });
    assert.ok(c1.targetRoles.includes('Staff HR Manager'));
    assert.ok(c1.confirmedAt);
    const c2 = confirmProfile(withInf, {});
    assert.ok(!c2.targetRoles.includes('Staff HR Manager'));
  });
});

describe('matcher + shared job store', () => {
  const JOBS = [
    { title: 'Senior HR Manager', company: 'Acme', location: 'Austin, TX', url: 'https://a/1', source: 'dice', description: 'talent acquisition, Workday' },
    { title: 'Senior HR Manager', company: 'Acme Inc', location: 'Austin, TX', url: 'https://b/2', source: 'linkedin', description: 'talent acquisition, Workday' },
    { title: 'Backend Engineer', company: 'Beta', location: 'Remote - US', url: 'https://c/3', source: 'dice', description: 'Python APIs' },
  ];
  it('one canonical record per job across boards (no per-user duplication)', () => {
    const store = emptyStore();
    const r1 = upsertJobs(store, JOBS);
    assert.deepEqual([r1.added, r1.updated, r1.unchanged], [2, 1, 0]);
    assert.equal(allJobs(store).length, 2);
    const r2 = upsertJobs(store, JOBS);
    assert.equal(r2.added, 0);
    const acme = allJobs(store).find((j) => j.company.startsWith('Acme'));
    assert.ok(acme.sources.includes('dice') && acme.sources.includes('linkedin'));
    assert.ok(getJob(store, acme.jobId).seenCount >= 2);
  });
  it('match() returns the full result contract', () => {
    const r = matchJob(JOBS[0], HR, { jobId: 'j1', profileId: 'hr-1' });
    assert.equal(r.jobId, 'j1');
    assert.equal(r.profileId, 'hr-1');
    assert.ok(r.score >= 75);
    assert.ok(r.band.label);
    assert.ok(r.matchedSignals.some((s) => /workday/i.test(s)));
    assert.ok(r.createdAt && r.updatedAt);
  });
});

describe('match history + outcomes', () => {
  it('tracks changes, views, and lawful outcome transitions', () => {
    const h = emptyHistory();
    const job = { title: 'T', company: 'C', location: 'Austin, TX', url: 'https://x/1' };
    const r1 = { score: 80, band: { label: 'review' }, reasons: [], penalties: [], matchedSignals: [], missingSignals: [] };
    const { entry, isNew } = recordMatch(h, { jobId: 'j', profileId: 'p', result: r1, job, profile: HR });
    assert.equal(isNew, true);
    assert.equal(entry.outcome, 'surfaced');
    assert.equal(markViewed(h, { jobId: 'j', profileId: 'p' }).outcome, 'viewed');
    const r2 = { ...r1, score: 85 };
    const again = recordMatch(h, { jobId: 'j', profileId: 'p', result: r2, job, profile: HR });
    assert.equal(again.isNew, false);
    assert.equal(again.entry.scoreChanged, true);
    assert.equal(again.entry.jobChanged, false);
    assert.deepEqual(recordOutcome(h, { jobId: 'j', profileId: 'p', outcome: 'applied' }), { entry: again.entry, ok: true });
    assert.equal(recordOutcome(h, { jobId: 'j', profileId: 'p', outcome: 'hired' }).ok, false); // applied → hired illegal
    assert.equal(recordOutcome(h, { jobId: 'j', profileId: 'p', outcome: 'bogus' }).ok, false);
    assert.ok(OUTCOMES.includes('interview') && OUTCOMES.includes('offer'));
  });
});

describe('privacy boundary', () => {
  it('redacts PII from logs; persisted profiles carry no resume text', () => {
    const red = redactForLogs({ email: 'a@b.com', note: 'call 512-555-0100 or me@x.io please' });
    assert.equal(red.email, '[redacted]');
    assert.ok(!red.note.includes('512-555-0100') && !red.note.includes('me@x.io'));
    const str = JSON.stringify(HR);
    assert.ok(!str.includes('@'));
    assert.ok(!/example\.com/.test(str));
  });
});
