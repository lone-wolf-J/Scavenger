// Personalization-readiness + cold-start tests (Phase 10 §17, §20).
// Gates output eligibility booleans + counts — never adjusted weights.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { personalizationReadiness, coldStartStage, READINESS_DEFAULTS } from '../lib/personalization-gates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('personalization readiness gates', () => {
  it('empty data is not ready, per dimension', () => {
    const r = personalizationReadiness({ outcomes: {}, distinctOutcomes: [], signalSamples: [] });
    assert.equal(r.ready, false);
    for (const k of ['surfaced', 'viewed', 'saved', 'rejected', 'applied', 'outcomeDiversity']) {
      assert.equal(r.dimensions[k].sufficient, false);
      assert.ok(r.dimensions[k].minimum > 0);
    }
  });

  it('ready only when every dimension passes (no global shortcut)', () => {
    const full = {
      outcomes: { surfaced: 200, viewed: 60, saved: 20, rejected: 15, applied: 8 },
      distinctOutcomes: ['saved', 'rejected', 'applied'],
      signalSamples: [{ signal: 'python', samples: 40 }, { signal: 'aws', samples: 31 }],
    };
    assert.equal(personalizationReadiness(full).ready, true);
    // Drop exactly one dimension → not ready.
    const thin = { ...full, outcomes: { ...full.outcomes, applied: 2 } };
    const r = personalizationReadiness(thin);
    assert.equal(r.ready, false);
    assert.equal(r.dimensions.applied.sufficient, false);
    assert.equal(r.dimensions.saved.sufficient, true);
  });

  it('per-signal gate needs every tracked signal sufficient', () => {
    const r = personalizationReadiness({
      outcomes: { surfaced: 200, viewed: 60, saved: 20, rejected: 15, applied: 8 },
      distinctOutcomes: ['saved', 'rejected', 'applied'],
      signalSamples: [{ signal: 'python', samples: 40 }, { signal: 'cobol', samples: 2 }],
    });
    assert.equal(r.dimensions.perSignal.sufficient, false);
    assert.equal(r.ready, false);
  });

  it('minimums are parameters with documented defaults', () => {
    assert.deepEqual(READINESS_DEFAULTS, {
      minSurfaced: 100, minViewed: 30, minSaved: 10, minRejected: 10,
      minApplied: 5, minOutcomeDiversity: 3, minPerSignal: 30,
    });
    const r = personalizationReadiness({
      outcomes: { surfaced: 5, viewed: 5, saved: 5, rejected: 5, applied: 5 },
      distinctOutcomes: ['saved', 'rejected', 'applied'],
      signalSamples: [{ signal: 'x', samples: 5 }],
      minimums: { minSurfaced: 5, minViewed: 5, minSaved: 5, minRejected: 5, minApplied: 5, minPerSignal: 5 },
    });
    assert.equal(r.ready, true);
  });

  it('gates never emit weights or adjustments', () => {
    const r = personalizationReadiness({
      outcomes: { surfaced: 500, viewed: 200, saved: 100, rejected: 100, applied: 50 },
      distinctOutcomes: ['saved', 'rejected', 'applied', 'interview'],
      signalSamples: [{ signal: 'x', samples: 100 }],
    });
    assert.ok(!('weights' in r) && !('adjustments' in r) && !('score' in r));
    assert.equal(r.ready, true);
  });
});

describe('cold start', () => {
  it('every stage keeps deterministic baseline + full functionality', () => {
    for (const n of [0, 1, 5, 10, 29, 30, 500]) {
      const s = coldStartStage({ outcomeCount: n });
      assert.equal(s.scoring, 'deterministic-baseline');
      assert.equal(s.personalization, 'off');
      assert.equal(s.functionality, 'full');
    }
    assert.equal(coldStartStage({ outcomeCount: 0 }).stage, 'zero');
    assert.equal(coldStartStage({ outcomeCount: 1 }).stage, 'one');
    assert.equal(coldStartStage({ outcomeCount: 5 }).stage, 'few');
    assert.equal(coldStartStage({ outcomeCount: 10 }).stage, 'growing');
    assert.equal(coldStartStage({ outcomeCount: 30 }).stage, 'established');
  });
});

describe('calibration study spec', () => {
  it('is machine-readable and binds the safety rails', () => {
    const spec = JSON.parse(readFileSync(join(HERE, '..', 'calibration-study.json'), 'utf8'));
    assert.ok(spec.observationsRequired.surfaced.minimum >= 100);
    assert.ok(spec.forbiddenFeatures.includes('resume text'));
    assert.ok(spec.biasAndSelectionLimits.length > 0);
    assert.ok(spec.rollback.triggers.length > 0);
    assert.ok(spec.coldStart['0 outcomes'].includes('deterministic'));
    assert.match(spec.versioning.matcherVersion, /MATCHER_VERSION/);
  });
});
