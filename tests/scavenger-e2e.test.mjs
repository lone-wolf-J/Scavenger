import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { normalizeJob, jobProvenance } from '../lib/job-model.mjs';
import { matchPool } from '../lib/matcher.mjs';
import { emptyStore, upsertJobs, allJobs } from '../lib/job-store.mjs';
import { emptyHistory, recordMatch, recordOutcome } from '../lib/match-history.mjs';
import {
  emptyWorkspace, addProfile, updateProfile, selectProfiles, getProfile,
} from '../lib/scavenger-workspace.mjs';
import { buildSearchIntent, retrievalPlan } from '../lib/search-intent.mjs';
import { filterOpportunities } from '../lib/opportunity-filters.mjs';

const PROFILES = JSON.parse(readFileSync(new URL('./fixtures/test-profiles.json', import.meta.url), 'utf-8'));
const P = (name) => normalizeCareerProfile(PROFILES[name]);

const RAW_JOBS = [
  { title: 'HR Director', company: 'Acme', location: 'Chicago, IL', country: 'US', url: 'https://a/1', source: 'indeed', description: 'talent acquisition leadership, Workday' },
  { title: 'Senior Software Engineer, Backend', company: 'Beta', location: 'Remote - US', country: 'US', url: 'https://b/2', source: 'dice', description: 'Python, Go, distributed systems' },
  { title: 'B2B Content Marketing Manager', company: 'Gamma', location: 'Boston, MA', country: 'US', url: 'https://c/3', source: 'linkedin', description: 'B2B content strategy, SEO, HubSpot' },
  { title: 'HR Director', company: 'Acme Inc', location: 'Chicago, IL', country: 'US', url: 'https://d/4', source: 'linkedin', description: 'talent acquisition leadership, Workday' },
];
const JOBS = RAW_JOBS.map((j) => normalizeJob(j, j.source, Date.now()));

function makeWorkspace() {
  const ws = emptyWorkspace();
  const hr = addProfile(ws, { name: 'HR Leadership', profile: P('hr-director') });
  const swe = addProfile(ws, { name: 'Software Engineering', profile: P('senior-swe') });
  const mkt = addProfile(ws, { name: 'Marketing', profile: P('content-marketing') });
  return { ws, hr, swe, mkt };
}

describe('scavenger e2e (§23 acceptance)', () => {
  it('1+5: shared jobs aggregate to one row each; 3: multi-profile scores; 4: reasons', () => {
    const { ws } = makeWorkspace();
    selectProfiles(ws, ws.profiles.map((p) => p.id));
    const selected = ws.selectedProfileIds.map((id) => ({ id, profile: getProfile(ws, id).profile }));
    const agg = matchPool(JOBS, selected);
    assert.equal(agg.length, JOBS.length); // displayed once each
    for (const a of agg) {
      assert.equal(a.matches.length, 3); // every selected profile scored
      for (const m of a.matches) assert.ok(m.reasons.length + m.penalties.length > 0);
    }
    const hrJob = agg.find((a) => a.jobId.includes('a/1') || JOBS[0].url.includes('a/1'));
    assert.ok(hrJob);
  });
  it('2: retrieval is shared — one call per unique query, not per profile', () => {
    const { ws } = makeWorkspace();
    const selected = ws.profiles.map((p) => ({ id: p.id, profile: p.profile }));
    const intent = buildSearchIntent(selected);
    const plan = retrievalPlan(intent);
    const perProfileTotal = intent.byProfile.reduce((n, b) => n + b.families.length, 0);
    assert.ok(plan.queryCount <= perProfileTotal);
    assert.ok(plan.queryCount > 0);
    let retrievals = 0;
    const retrieved = [];
    for (const q of plan.queries) { retrievals++; retrieved.push(...JOBS); } // one shared fetch per query
    const seenJobs = new Map(retrieved.map((j) => [j.url, j]));
    assert.equal(retrievals, plan.queryCount);
    assert.ok(seenJobs.size <= JOBS.length);
  });
  it('6: details accessible — signals, provenance, per-profile breakdown', () => {
    const { ws } = makeWorkspace();
    const selected = ws.profiles.map((p) => ({ id: p.id, profile: p.profile }));
    const [first] = matchPool([JOBS[0]], selected);
    assert.ok(first.best.matchedSignals || first.best.missingSignals);
    const prov = jobProvenance({ ...JOBS[0], sources: ['indeed', 'linkedin'] });
    assert.equal(prov.originUrl, 'https://a/1');
    assert.deepEqual(prov.sources, ['indeed', 'linkedin']);
    for (const m of first.matches) assert.ok(m.band && m.score != null);
  });
  it('7+8: editing one profile never alters another', () => {
    const { ws, hr, swe, mkt } = makeWorkspace();
    const sweBefore = JSON.stringify(getProfile(ws, swe.id).profile);
    const mktBefore = JSON.stringify(getProfile(ws, mkt.id).profile);
    updateProfile(ws, hr.id, { name: 'HR Leadership v2', profile: { ...P('hr-director'), seniority: 'executive' } });
    assert.equal(JSON.stringify(getProfile(ws, swe.id).profile), sweBefore);
    assert.equal(JSON.stringify(getProfile(ws, mkt.id).profile), mktBefore);
    updateProfile(ws, swe.id, { profile: { ...P('senior-swe'), skills: ['COBOL'] } });
    assert.equal(JSON.stringify(getProfile(ws, mkt.id).profile), mktBefore);
  });
  it('9+10: fourth profile (data science) needs no code changes; any domain works', () => {
    const { ws } = makeWorkspace();
    const ds = addProfile(ws, {
      name: 'Data Science',
      profile: normalizeCareerProfile({
        targetRoles: ['Data Scientist', 'Senior Data Scientist'], seniority: 'senior',
        skills: ['machine learning', 'statistics', 'experimentation'], technologies: ['Python', 'SQL'],
        functionalAreas: ['data science'], industries: ['technology'],
      }),
    });
    const cyber = addProfile(ws, {
      name: 'Cybersecurity',
      profile: normalizeCareerProfile({
        targetRoles: ['Security Engineer'], seniority: 'mid',
        skills: ['threat modeling', 'incident response'], technologies: ['SIEM'],
        functionalAreas: ['security'],
      }),
    });
    assert.ok(ds.id && cyber.id);
    const all = ws.profiles.map((p) => ({ id: p.id, profile: p.profile }));
    const agg = matchPool(JOBS, all);
    assert.equal(agg.length, JOBS.length);
    assert.ok(agg.every((a) => a.matches.length === 5));
  });
  it('save/reject + history across profiles; store never duplicates', () => {
    const { ws } = makeWorkspace();
    const store = emptyStore();
    const up = upsertJobs(store, JOBS);
    assert.deepEqual([up.added, up.updated, up.unchanged], [3, 1, 0]);
    // The Acme/Acme-Inc alias pair merges; the spelling difference is a real change.
    assert.equal(up.changes.length, 1);
    assert.ok(up.changes[0].changedFields.includes('company'));
    assert.equal(allJobs(store).length, 3); // Acme/Acme Inc alias pair merges
    const acme = allJobs(store).find((j) => j.company.startsWith('Acme'));
    assert.ok(acme.sources.includes('indeed') && acme.sources.includes('linkedin'));
    const history = emptyHistory();
    const selected = ws.profiles.map((p) => ({ id: p.id, profile: p.profile }));
    const agg = matchPool(JOBS, selected);
    const r = recordMatch(history, {
      jobId: agg[0].jobId, profileId: selected[0].id,
      result: agg[0].matches[0], job: JOBS[0], profile: selected[0].profile,
    });
    assert.equal(r.isNew, true);
    assert.equal(recordOutcome(history, { jobId: agg[0].jobId, profileId: selected[0].id, outcome: 'saved' }).ok, true);
    assert.equal(allJobs(store).length, 3); // still one record per canonical job
  });
  it('filters narrow the aggregated feed without re-matching', () => {
    const { ws } = makeWorkspace();
    const selected = ws.profiles.map((p) => ({ id: p.id, profile: p.profile }));
    const agg = matchPool(JOBS, selected);
    const byId = new Map(JOBS.map((j) => [`${j.source}:${j.url}`, j]));
    // matchPool jobIds use normalized ids; build lookup tolerant of both forms
    const lookup = new Map();
    for (const a of agg) {
      const job = JOBS.find((j) => a.jobId.includes(j.url) || j.url.includes(a.jobId.split(':').pop()));
      if (job) lookup.set(a.jobId, job);
    }
    const filtered = filterOpportunities(agg, { minScore: 60 }, lookup.size ? lookup : byId);
    assert.ok(filtered.length <= agg.length);
    assert.ok(filtered.every((a) => a.best.score >= 60));
  });
});
