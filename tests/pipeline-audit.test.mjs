import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeJob } from '../lib/job-model.mjs';
import { classifyUsLocation } from '../lib/us-location.mjs';
import { canonicalJobKey, mergeIntoCanonical } from '../lib/job-dedup.mjs';
import { scoreJob } from '../lib/match-score.mjs';
import { scoreEmployer, aggregateDiscovery } from '../lib/employer-discovery.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/phase2-pipeline.json', import.meta.url), 'utf-8'));
const PROFILES = JSON.parse(readFileSync(new URL('./fixtures/test-profiles.json', import.meta.url), 'utf-8'));

const NOW = Date.now();
const HOUR = 3600_000;
function postedAt(v) {
  if (typeof v !== 'string') return undefined;
  const m = v.match(/^now-(\d+)(h|d)$/);
  if (m) return NOW - Number(m[1]) * (m[2] === 'h' ? HOUR : 24 * HOUR);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
const byId = (id) => FIX.cases.find((c) => c.id === id).job;
const norm = (id) => {
  const j = { ...byId(id), postedAt: postedAt(byId(id).postedAt) };
  return normalizeJob(j, j.source, NOW);
};
const P = (name) => normalizeCareerProfile(PROFILES[name]);

// Full pipeline stage runner: normalize → US gate → score.
function pipeline(id, profileName) {
  const job = norm(id);
  const loc = classifyUsLocation(job.location, { url: job.url });
  const scored = loc.verdict === 'us' ? scoreJob(job, P(profileName)) : null;
  return { job, loc, scored };
}

describe('phase2 pipeline audit (16-case fixture set)', () => {
  it('excellent match scores strong+ for the content profile', () => {
    const { loc, scored } = pipeline('excellent-match', 'content-marketing');
    assert.equal(loc.verdict, 'us');
    assert.ok(scored.score >= 75, `score=${scored.score} band=${scored.band.label}`);
    assert.ok(scored.reasons.length > 0);
  });
  it('obvious false positive scores reject for every profile', () => {
    for (const name of Object.keys(PROFILES)) {
      const { scored } = pipeline('false-positive', name);
      assert.ok(scored.score < 60, `${name}: ${scored.score}`);
    }
  });
  it('duplicates across LinkedIn+Dice+career site merge to one opportunity', () => {
    const store = new Map();
    const rs = ['duplicate-a', 'duplicate-b', 'duplicate-c'].map((id) => mergeIntoCanonical(store, norm(id)));
    assert.deepEqual(rs.map((r) => r.isNew), [true, false, false]);
    assert.equal(store.size, 1);
    assert.deepEqual([...store.values()][0].sources.sort(), ['dice', 'greenhouse', 'linkedin']);
    assert.equal(canonicalJobKey(norm('duplicate-a')), canonicalJobKey(norm('duplicate-c')));
  });
  it('staffing post goes to review, never auto-add', () => {
    const d = scoreEmployer({ company: 'TekSystems Staffing', location: 'Dallas, TX' }, { sources: ['dice'] });
    assert.ok(d.tier !== 'high');
    assert.ok(d.evidence.some((e) => /staffing/i.test(e)));
  });
  it('missing employer is rejected with a reason', () => {
    const d = scoreEmployer({ company: '', location: 'Remote - US' });
    assert.equal(d.tier, 'low');
    assert.equal(d.rejectReason, 'missing-company');
  });
  it('ambiguous aliases (Acme Inc. vs ACME) aggregate to one candidate', () => {
    const agg = aggregateDiscovery([
      { ...byId('ambiguous-a'), _discoverySource: 'indeed' },
      { ...byId('ambiguous-b'), _discoverySource: 'ziprecruiter' },
    ]);
    assert.equal(agg.decisions.length, 1);
    assert.equal(agg.decisions[0].jobCount, 2);
  });
  it('US remote passes; worldwide remote, Canada, India, US+Canada-multi do not', () => {
    assert.equal(pipeline('us-remote', 'hr-director').loc.verdict, 'us');
    assert.equal(classifyUsLocation(byId('worldwide-remote').location).verdict, 'non-us');
    assert.equal(classifyUsLocation(byId('canada').location).verdict, 'non-us');
    assert.equal(classifyUsLocation(byId('india').location).verdict, 'non-us');
    // Strict mode: an explicit non-US marker wins even beside a US one.
    assert.equal(classifyUsLocation(byId('us-canada-multi').location).verdict, 'non-us');
  });
  it('senior AI role is strong for AI leadership, junior AI vetoed', () => {
    const senior = pipeline('senior-ai-role', 'ai-leadership');
    assert.ok(senior.scored.score >= 75, `score=${senior.scored.score}`);
    const junior = pipeline('junior-ai-role', 'ai-leadership');
    assert.ok(junior.scored.score <= 20);
    // Same junior role is NOT vetoed for a junior profile.
    const juniorOk = scoreJob(norm('junior-ai-role'), normalizeCareerProfile({ targetRoles: ['Machine Learning Engineer'], seniority: 'junior' }));
    assert.ok(juniorOk.score > 20);
  });
  it('generic SWE is mid-band for senior SWE, weak for HR', () => {
    const swe = pipeline('generic-swe', 'senior-swe');
    assert.ok(swe.scored.score >= 60 && swe.scored.score < 85, `score=${swe.scored.score}`);
    const hr = pipeline('generic-swe', 'hr-director');
    assert.ok(hr.scored.score < swe.scored.score);
  });
  it('senior solutions architect is strong for AI leadership (client-facing recognized)', () => {
    const r = pipeline('senior-solutions-architect', 'ai-leadership');
    assert.ok(r.scored.score >= 75, `score=${r.scored.score}`);
    assert.ok(r.scored.reasons.some((x) => /solution|architect/i.test(x)) || r.scored.score >= 85);
  });
  it('content role is strong for content profile, weak for HR director', () => {
    const content = pipeline('marketing-content-role', 'content-marketing');
    const hr = pipeline('marketing-content-role', 'hr-director');
    assert.ok(content.scored.score >= 75, `score=${content.scored.score}`);
    assert.ok(hr.scored.score < 60, `hr=${hr.score}`);
  });
});

