import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCareerProfile, fromConfigProfile, extractProfileSignals, parseCompMin } from '../lib/career-profile.mjs';
import { generateSearchFamilies, familyQuery, clusterRolesToFamilies } from '../lib/search-generation.mjs';
import { scoreJob, scoreToBand } from '../lib/match-score.mjs';
import { titleScope, isClientFacing, titleGateFor, seniorityOf } from '../lib/title-gate.mjs';

const PROFILES = JSON.parse(readFileSync(new URL('./fixtures/test-profiles.json', import.meta.url), 'utf-8'));

describe('career-profile', () => {
  it('normalizes partial input with confidence below 1', () => {
    const p = normalizeCareerProfile({ targetRoles: ['HR Director'] });
    assert.deepEqual(p.targetRoles, ['HR Director']);
    assert.equal(p.skills.length, 0);
    assert.ok(p.profileConfidence < 1 && p.profileConfidence > 0);
    assert.equal(normalizeCareerProfile(null).profileConfidence, 0);
  });
  it('maps legacy scorer profiles forward', () => {
    const p = normalizeCareerProfile({ targetRoles: ['X'], seniority: 'senior', compensation: { min: 80000 }, exclusions: ['Junior'] });
    assert.equal(p.seniority, 'senior');
    assert.equal(p.compensationPrefs.min, 80000);
    assert.deepEqual(p.exclusions, ['junior']);
  });
  it('parses compensation minimums', () => {
    assert.equal(parseCompMin('$70K'), 70000);
    assert.equal(parseCompMin('$80K-120K'), 80000);
    assert.equal(parseCompMin('150000'), 150000);
    assert.equal(parseCompMin(''), 0);
  });
  it('builds a profile from config/profile.yml shape', () => {
    const p = fromConfigProfile({
      target_roles: { primary: ['Content Marketing Specialist'], archetypes: [{ level: 'Mid-Senior' }] },
      compensation: { minimum: '$70K', currency: 'USD' },
      location: { country: 'United States' },
    });
    assert.equal(p.seniority, 'senior');
    assert.equal(p.compensationPrefs.min, 70000);
    assert.ok(p.profileConfidence > 0);
  });
  it('extracts skills sections domain-neutrally', () => {
    const sig = extractProfileSignals('Jane Doe\nSkills\nWorkday, Greenhouse, talent acquisition\nExperience\nACME — HR Manager');
    assert.deepEqual(sig.skills, ['Workday', 'Greenhouse', 'talent acquisition']);
    assert.deepEqual(extractProfileSignals('').skills, []);
  });
});

describe('search-generation', () => {
  it('derives families from the profile, not a hardcoded list', () => {
    const fams = generateSearchFamilies(normalizeCareerProfile(PROFILES['hr-director']));
    assert.ok(fams.length >= 2);
    assert.ok(fams[0].positives.some((t) => /HR Director/.test(t)));
    assert.ok(fams.every((f) => f.negatives.includes('intern')));
    assert.ok(fams[0].weight >= fams[fams.length - 1].weight);
    const q = familyQuery(fams[0]);
    assert.ok(q.includes('"HR Director"'));
  });
  it('clusters by head noun and skips junior markers for junior profiles', () => {
    const fams = generateSearchFamilies(normalizeCareerProfile({ targetRoles: ['Junior Designer'], seniority: 'junior' }));
    assert.ok(!fams[0].negatives.includes('junior'));
    const clusters = clusterRolesToFamilies(['AI Engineer', 'ML Engineer', 'HR Director']);
    assert.equal(clusters.length, 2); // engineer x2, director x1
  });
  it('same generator serves SWE and content profiles', () => {
    const swe = generateSearchFamilies(normalizeCareerProfile(PROFILES['senior-swe']));
    const content = generateSearchFamilies(normalizeCareerProfile(PROFILES['content-marketing']));
    assert.ok(swe[0].positives.join(' ').match(/Engineer/));
    assert.ok(content[0].positives.join(' ').match(/Content|SEO/));
  });
});

describe('match-score v2 bands', () => {
  it('labels bands 95/85/75/60 correctly', () => {
    assert.equal(scoreToBand(97).label, 'exceptional');
    assert.equal(scoreToBand(90).label, 'strong');
    assert.equal(scoreToBand(80).label, 'review');
    assert.equal(scoreToBand(65).label, 'weak');
    assert.equal(scoreToBand(40).label, 'reject');
  });
  it('same job scores differently per profile (HR vs SWE vs content)', () => {
    const job = { title: 'Senior HR Manager, Workday HCM', company: 'Acme', location: 'Austin, TX', country: 'US', description: 'talent acquisition leadership, Workday' };
    const hr = scoreJob(job, PROFILES['hr-director']);
    const swe = scoreJob(job, PROFILES['senior-swe']);
    const content = scoreJob(job, PROFILES['content-marketing']);
    assert.ok(hr.score > swe.score && hr.score > content.score, `hr=${hr.score} swe=${swe.score} content=${content.score}`);
    assert.ok(hr.reasons.some((r) => /Workday|talent acquisition/i.test(r)));
  });
  it('AI leadership profile recognizes forward-deployed scope; content profile does not', () => {
    const job = { title: 'Forward Deployed AI Engineer', company: 'Acme', location: 'Remote - US', country: 'US', description: 'LLM systems for enterprise customers' };
    const ai = scoreJob(job, PROFILES['ai-leadership']);
    const content = scoreJob(job, PROFILES['content-marketing']);
    assert.ok(ai.score > content.score + 10, `ai=${ai.score} content=${content.score}`);
  });
  it('junior veto is context-aware, not global', () => {
    const junior = { title: 'Junior AI Engineer', company: 'A', location: 'Austin, TX', country: 'US' };
    const r1 = scoreJob(junior, PROFILES['ai-leadership']);
    assert.ok(r1.score <= 20 && r1.penalties.some((p) => /Junior marker/i.test(p)));
    // Same title is NOT vetoed for a junior profile.
    const juniorProfile = normalizeCareerProfile({ targetRoles: ['Junior AI Engineer'], seniority: 'junior' });
    const r2 = scoreJob(junior, juniorProfile);
    assert.ok(!r2.penalties.some((p) => /Junior marker/i.test(p)));
    // Associate Director is never treated as junior.
    const assoc = scoreJob({ title: 'Associate Director, Content', company: 'A', location: 'Remote - US', country: 'US' }, PROFILES['content-marketing']);
    assert.ok(!assoc.penalties.some((p) => /associate/i.test(p)));
  });
  it('every score carries reasons or penalties (never bare)', () => {
    for (const [name, raw] of Object.entries(PROFILES)) {
      const r = scoreJob({ title: 'Staff Product Designer', company: 'Acme', location: 'New York, NY', country: 'US' }, raw);
      assert.ok(r.reasons.length + r.penalties.length > 0, name);
      assert.ok(r.band && r.band.label);
      assert.ok(Object.values(r.breakdown).every((v) => Number.isFinite(v)));
    }
  });
});

describe('title-gate', () => {
  it('separates seniority levels', () => {
    assert.equal(seniorityOf('Junior QA Tester'), 'junior');
    assert.equal(seniorityOf('Senior Solutions Architect'), 'senior');
    assert.equal(seniorityOf('Head of Engineering'), 'head');
    assert.equal(seniorityOf('Software Engineer'), 'mid');
  });
  it('separates leadership from IC and client-facing from internal', () => {
    assert.equal(titleScope('Director of Engineering'), 'leadership');
    assert.equal(titleScope('Engineering Manager'), 'leadership');
    assert.equal(titleScope('Senior Software Engineer'), 'ic');
    assert.equal(titleScope('Sales Lead'), 'ic'); // lead list, not a leader
    assert.equal(isClientFacing('Forward Deployed Software Engineer'), true);
    assert.equal(isClientFacing('AI Solutions Architect'), true);
    assert.equal(isClientFacing('Backend Engineer'), false);
  });
  it('family gate: positives pass, exclusions and junior markers veto, others miss', () => {
    const gate = titleGateFor({ positives: ['Solutions Architect', 'Customer Engineer'] }, normalizeCareerProfile(PROFILES['ai-leadership']));
    assert.equal(gate('Senior Solutions Architect').pass, true);
    assert.equal(gate('Junior Solutions Architect').pass, false);
    assert.equal(gate('Payroll Specialist').pass, false);
    const excl = titleGateFor({ positives: ['HR Director'] }, normalizeCareerProfile({ targetRoles: ['HR Director'], seniority: 'director', exclusions: ['sales'] }));
    assert.equal(excl('Sales Director').pass, false);
  });
});

