// Real-corpus evaluation tests (Phase 12): schema, versioning, density,
// human records, label-vs-band separation, FN investigation, loss analysis.
// Corpus v1 is committed; score expectations are pinned to MATCHER_VERSION
// 1.0 — a deliberate scorer change must update these numbers AND the version.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateCorpusRecord, normalizeCorpusRecord, buildCorpusMetadata,
  validateHumanEval, sourceIdFromUrl, EVALUATION_LABELS,
} from '../lib/eval-corpus.mjs';
import { measureEvidenceDensity } from '../lib/evidence-density.mjs';
import { analyzeLocationLoss, analyzeFreshnessLoss, analyzeDedup } from '../lib/loss-analysis.mjs';
import { compareLabelsToBands, investigateLabelDeviations } from '../lib/human-eval.mjs';
import { matchJob, MATCHER_VERSION } from '../lib/matcher.mjs';
import { diagnoseMatch } from '../lib/match-diagnostics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const V1 = join(HERE, 'fixtures', 'eval-corpus', 'v1');
const loadCorpus = () => JSON.parse(readFileSync(join(V1, 'corpus.json'), 'utf8'));
const loadEvals = () => JSON.parse(readFileSync(join(V1, 'human-evals.json'), 'utf8'));
const loadProfiles = () => Object.fromEntries(readdirSync(join(HERE, 'fixtures', 'eval-profiles'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => { const p = JSON.parse(readFileSync(join(HERE, 'fixtures', 'eval-profiles', f), 'utf8')); return [p.id, p.profile]; }));
const toJob = (rec) => ({
  title: rec.title, company: rec.company || '', location: rec.location || '',
  description: rec.description || '', url: rec.sourceUrl, sources: [rec.source],
  employmentType: rec.employmentType || undefined,
});
const scoreAll = () => {
  const corpus = loadCorpus();
  const evals = loadEvals();
  const profiles = loadProfiles();
  const byEvalId = Object.fromEntries(corpus.records.map((r) => [r.evaluationId, r]));
  const scoresByKey = {};
  const diagnosticsByKey = {};
  for (const e of evals.evaluations) {
    const key = `${e.profileId}::${e.evaluationJobId}`;
    const m = matchJob(toJob(byEvalId[e.evaluationJobId]), profiles[e.profileId], { now: 0 });
    scoresByKey[key] = { score: m.score, band: m.band };
    diagnosticsByKey[key] = diagnoseMatch({ job: toJob(byEvalId[e.evaluationJobId]), profile: profiles[e.profileId], now: 0 });
  }
  return { scoresByKey, diagnosticsByKey };
};

describe('corpus schema + versioning (§2–3)', () => {
  it('v1 corpus validates record by record', () => {
    const corpus = loadCorpus();
    assert.equal(corpus.meta.corpusVersion, 'v1');
    assert.equal(corpus.meta.recordCount, corpus.records.length);
    assert.ok(corpus.records.length >= 100);
    for (const r of corpus.records) {
      const v = validateCorpusRecord(r);
      assert.equal(v.ok, true, `${r.evaluationId}: ${v.errors.join('; ')}`);
    }
    assert.deepEqual(Object.keys(corpus.meta.sourceCounts).sort(), ['dice', 'greenhouse']);
    assert.equal(corpus.meta.profileCoverage.length, 5);
    assert.ok(corpus.meta.captureWindow?.start && corpus.meta.captureWindow?.end);
  });

  it('rejects PII and unknown fields', () => {
    assert.equal(validateCorpusRecord({ evaluationId: 'x', source: 's', sourceJobId: '1', title: 'T with a@b.com inside', location: 'L', sourceUrl: 'u', capturedAt: 't' }).ok, false);
    assert.equal(validateCorpusRecord({ evaluationId: 'x', source: 's', sourceJobId: '1', title: 'T', location: 'L', sourceUrl: 'u', capturedAt: 't', resume: 'x' }).ok, false);
    assert.equal(validateCorpusRecord(null).ok, false);
  });

  it('normalizes provider jobs and derives native ids from URLs', () => {
    const r = normalizeCorpusRecord({ title: 'T', url: 'https://www.dice.com/job-detail/abc-123' }, { source: 'dice', evaluationId: 'e1' });
    assert.equal(r.sourceJobId, 'abc-123');
    assert.equal(sourceIdFromUrl('https://job-boards.greenhouse.io/acme/jobs/42'), '42');
    assert.equal(sourceIdFromUrl('https://example.com/x'), '');
  });

  it('metadata is immutable-by-convention (versioned, never silently replaced)', () => {
    const m = buildCorpusMetadata({ version: 'v9', records: [{ source: 'dice' }], profileCoverage: ['p'] });
    assert.equal(m.corpusVersion, 'v9');
    assert.deepEqual(m.sourceCounts, { dice: 1 });
  });
});

describe('evidence density (§7)', () => {
  it('real corpus: dice records carry no descriptions, greenhouse records do', () => {
    const corpus = loadCorpus();
    const density = measureEvidenceDensity({ records: corpus.records });
    assert.equal(density.records, corpus.records.length);
    assert.ok(density.fields.title.rate >= 0.99);
    const diceWithDesc = corpus.records.filter((r) => r.source === 'dice' && r.description);
    assert.equal(diceWithDesc.length, 0);
    assert.ok(density.descriptionLength.withDescription > 0);
    assert.ok(density.fields.salary.rate < 0.5, 'compensation is sparse in real postings');
  });
});

describe('human evaluations (§9–10)', () => {
  it('all 24 records validate and carry no scores', () => {
    const evals = loadEvals();
    assert.equal(evals.corpusVersion, 'v1');
    assert.equal(evals.evaluations.length, 24);
    for (const e of evals.evaluations) {
      const v = validateHumanEval(e);
      assert.equal(v.ok, true, `${e.evaluationId}: ${v.errors.join('; ')}`);
    }
    const labels = new Set(evals.evaluations.map((e) => e.evaluationLabel));
    for (const l of ['CLEAR_MATCH', 'PLAUSIBLE_MATCH', 'UNCLEAR', 'CLEAR_MISMATCH']) assert.ok(labels.has(l));
  });

  it('scores are rejected from human records (blindness enforced)', () => {
    const base = { evaluationId: 'e', profileId: 'p', evaluationJobId: 'j', evaluationLabel: 'CLEAR_MATCH', evaluatorId: 'x', evaluatedAt: 't', corpusVersion: 'v1' };
    assert.equal(validateHumanEval({ ...base, score: 80 }).ok, false);
    assert.equal(validateHumanEval({ ...base, evaluationLabel: 'S Tier' }).ok, false);
  });
});

describe('label vs band separation (§11, matcher v1.0)', () => {
  it('mismatches separate from matches, averages reflect thin evidence', () => {
    assert.equal(MATCHER_VERSION, '1.0');
    const { scoresByKey } = scoreAll();
    const evals = loadEvals();
    const cmp = compareLabelsToBands({ evaluations: evals.evaluations, scoresByKey });
    assert.equal(cmp.perLabel.CLEAR_MISMATCH.scored, 9);
    assert.ok(Object.keys(cmp.perLabel.CLEAR_MISMATCH.bands).every((b) => b === 'reject'));
    assert.ok(cmp.perLabel.CLEAR_MISMATCH.avgScore < 45);
    // Thin dice descriptions starve skill evidence: CLEAR_MATCH averages low.
    assert.ok(cmp.perLabel.CLEAR_MATCH.avgScore < 75);
    assert.ok(cmp.perLabel.CLEAR_MATCH.avgScore > cmp.perLabel.CLEAR_MISMATCH.avgScore + 15);
  });

  it('false negatives carry skill-evidence shortfalls, zero false positives', () => {
    const { scoresByKey, diagnosticsByKey } = scoreAll();
    const evals = loadEvals();
    const cmp = compareLabelsToBands({ evaluations: evals.evaluations, scoresByKey });
    const inv = investigateLabelDeviations({ joined: cmp.joined, diagnosticsByKey });
    assert.equal(inv.falsePositives.length, 0);
    assert.ok(inv.falseNegatives.length >= 1);
    for (const fn of inv.falseNegatives) {
      assert.ok(fn.missingEvidence.length > 0, `${fn.evaluationId}: FN without missing evidence?`);
      assert.ok(fn.contributors.some((c) => c.startsWith('title+25')), `${fn.evaluationId}: title should be full`);
    }
  });
});

describe('loss analysis (§15–17)', () => {
  it('location loss preserves foreign-marker precedence', () => {
    const out = analyzeLocationLoss({ jobs: loadCorpus().records.map((r) => ({ location: r.location, url: r.sourceUrl })) });
    assert.equal(out.retrieved, 120);
    assert.equal(out.usAccepted + out.foreignRejected + out.ambiguousRejected, 120);
    assert.ok(out.foreignRejected >= 3, 'Singapore/Munich/Sydney postings are foreign');
    assert.ok(out.usAccepted > out.foreignRejected);
  });

  it('freshness loss is measured per provider without changing thresholds', () => {
    const corpus = loadCorpus();
    const out = analyzeFreshnessLoss({ jobs: corpus.records, maxAgeDays: 7, now: Date.now() });
    assert.equal(out.retrieved, 120);
    assert.equal(out.fresh + out.staleRejected + out.undated, 120);
    assert.ok(out.byProvider.dice && out.byProvider.greenhouse);
  });

  it('dedup accounting counts sources per canonical job', () => {
    const out = analyzeDedup({
      records: [
        { jobId: 'a', sources: ['dice', 'greenhouse'], source: 'dice' },
        { jobId: 'b', sources: ['dice'], source: 'dice' },
      ],
    });
    assert.equal(out.canonicalJobs, 2);
    assert.equal(out.multiSource, 1);
    assert.equal(out.totalObservations, 3);
    assert.deepEqual(out.bySourceCount, { 1: 1, 2: 1 });
  });
});
