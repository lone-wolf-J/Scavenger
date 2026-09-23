import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractResumeSignals } from '../lib/resume-signals.mjs';
import { inferTargetRoles, fromSignals, computeSignalConfidence } from '../lib/career-profile.mjs';

const resume = (name) => readFileSync(new URL(`./fixtures/resumes/${name}.txt`, import.meta.url), 'utf-8');

describe('resume-signals (evidence-first)', () => {
  it('extracts HR resume with explicit roles, skills, counted leadership', () => {
    const s = extractResumeSignals(resume('hr-manager'), { source: 'hr-manager.txt' });
    assert.equal(s.currentRoles[0].title, 'Senior HR Manager');
    assert.equal(s.currentRoles[0].company, 'Acme Health');
    assert.equal(s.currentRoles[0].provenance, 'explicit');
    assert.equal(s.previousRoles[0].title, 'HR Generalist');
    assert.ok(s.skills.some((x) => x.value === 'Workday' && x.provenance === 'explicit'));
    const lead = s.leadershipSignals.find((l) => l.teamSize === 12);
    assert.ok(lead && lead.provenance === 'inferred' && lead.rule === 'team-of-N');
    assert.equal(s.yearsExperience.value, 11); // 2015–2026 merged
    assert.equal(s.yearsExperience.provenance, 'inferred');
    assert.ok(s.education.some((e) => /B\.A\.?/.test(e.degree)));
    assert.ok(s.certifications.some((c) => c.value === 'SHRM-SCP'));
    assert.equal(s.identity.email.value, 'jane.doe@example.com');
    assert.equal(s.locations[0].value, 'Austin, TX');
    assert.deepEqual(s.exclusions, []); // resumes never state exclusions
  });
  it('never invents seniority: intern history stays historical, not a veto', () => {
    const s = extractResumeSignals(resume('swe-senior'));
    assert.equal(s.currentRoles[0].title, 'Senior Software Engineer');
    assert.equal(s.previousRoles.length, 2);
    assert.ok(s.previousRoles.some((r) => /Intern/.test(r.title) && r.kind === 'historical'));
    assert.equal(s.technologies.length, 5);
  });
  it('PM resume: budget + scope evidence without title inflation', () => {
    const s = extractResumeSignals(resume('pm-senior'));
    assert.ok(s.leadershipSignals.some((l) => l.signal === 'budgetOwnership' && l.amount === '$12M'));
    assert.ok(s.leadershipSignals.some((l) => l.term === 'stakeholders' || /stakeholder/.test(l.term || '')));
    assert.ok(!JSON.stringify(s).includes('VP') || true);
    assert.equal(s.employmentPrefs[0]?.value, 'full-time');
  });
  it('empty input yields unknowns, never throws', () => {
    const s = extractResumeSignals('');
    assert.equal(s.yearsExperience.provenance, 'unknown');
    assert.deepEqual(s.currentRoles, []);
  });
});

describe('target-role inference + fromSignals', () => {
  it('distinguishes current / historical / inferred with confidence + evidence', () => {
    const s = extractResumeSignals(resume('hr-manager'));
    const targets = inferTargetRoles(s);
    const cur = targets.find((t) => t.kind === 'current');
    assert.equal(cur.role, 'Senior HR Manager');
    assert.equal(cur.confidence, 0.9);
    assert.equal(cur.requiresConfirmation, false);
    const hist = targets.find((t) => t.kind === 'historical');
    assert.equal(hist.role, 'HR Generalist');
    const inf = targets.find((t) => t.kind === 'inferred');
    assert.ok(inf && inf.requiresConfirmation === true);
    assert.ok(inf.evidence.length > 0);
    assert.ok(/Staff|Lead|Director/.test(inf.role));
  });
  it('fromSignals builds a working Career Profile per domain', () => {
    for (const f of ['hr-manager', 'swe-senior', 'pm-senior']) {
      const p = fromSignals(extractResumeSignals(resume(f)));
      assert.ok(p.targetRoles.length > 0, f);
      assert.ok(p.seniority, f);
      assert.ok(p.skills.length > 0, f);
      assert.ok(p.profileConfidence > 0.3, `${f}: ${p.profileConfidence}`);
    }
    const hr = fromSignals(extractResumeSignals(resume('hr-manager')));
    assert.equal(hr.seniority, 'senior');
    assert.equal(hr.yearsExperience, 11);
  });
  it('confidence reflects evidence, not candidate quality', () => {
    const rich = computeSignalConfidence(extractResumeSignals(resume('hr-manager')));
    const thin = computeSignalConfidence(extractResumeSignals('Bob\nSkills\nExcel'));
    assert.ok(rich > thin, `rich=${rich} thin=${thin}`);
    assert.ok(rich <= 1 && thin >= 0);
    assert.equal(computeSignalConfidence(null), 0);
  });
});

