// NOT_FOUND precision + absence-gate tests. No network; observations are
// constructed. Live and synthetic evidence are never merged.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  measureNotFoundPrecision,
  collectNotFoundObservations,
  evaluateAbsenceGate,
} from '../lib/verify-precision.mjs';

const obs = (provider, observed, confirmed, classification) => ({ provider, observed, confirmed, classification });

describe('not-found precision', () => {
  it('keeps live and synthetic evidence separate', () => {
    const out = measureNotFoundPrecision({
      observations: [
        obs('dice', 'NOT_FOUND', 'unavailable', 'live'),
        obs('dice', 'NOT_FOUND', 'available', 'live'),
        obs('dice', 'NOT_FOUND', 'unavailable', 'synthetic'),
        obs('dice', 'OTHER', 'available', 'live'),
      ],
    });
    assert.equal(out.live.notFoundObserved, 2);
    assert.equal(out.live.precision, 0.5);
    assert.equal(out.live.sample.sufficient, false);
    assert.equal(out.synthetic.notFoundObserved, 1);
    assert.equal(out.synthetic.precision, 1);
    assert.ok(!('combined' in out) && !('overall' in out));
  });

  it('precision is null with no confirmations, counts still reported', () => {
    const out = measureNotFoundPrecision({ observations: [obs('gh', 'NOT_FOUND', null, 'live')] });
    assert.equal(out.live.precision, null);
    assert.equal(out.live.unconfirmed, 1);
    assert.equal(out.live.sample.sufficient, false);
  });

  it('collects live observation volume from verification histories', () => {
    const rows = collectNotFoundObservations({
      records: [{
        jobId: 'k1',
        verificationHistory: [
          { provider: 'dice', status: 'NOT_FOUND', checkedAt: 't', evidence: { type: 'not_found_page' } },
          { provider: 'dice', status: 'ACTIVE', checkedAt: 't2' },
        ],
      }],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].observed, 'NOT_FOUND');
    assert.equal(rows[0].confirmed, null);
    assert.equal(rows[0].classification, 'live');
    assert.equal(rows[0].evidenceType, 'not_found_page');
  });
});

describe('absence gate', () => {
  it('INSUFFICIENT_DATA below the confirmed minimum', () => {
    const g = evaluateAbsenceGate({ providerId: 'dice', liveConfirmed: 4, livePrecision: 1 });
    assert.equal(g.state, 'INSUFFICIENT_DATA');
    assert.equal(g.recommendedFlag, false);
  });

  it('soft-404 ambiguity caps at EVALUATING even with perfect precision', () => {
    const g = evaluateAbsenceGate({
      providerId: 'dice', liveConfirmed: 60, livePrecision: 1,
      soft404Ambiguity: true, repeatStability: 5,
    });
    assert.equal(g.state, 'EVALUATING');
    assert.equal(g.recommendedFlag, false);
  });

  it('below-floor precision is NOT_ELIGIBLE', () => {
    const g = evaluateAbsenceGate({
      providerId: 'gh', liveConfirmed: 40, livePrecision: 0.9, repeatStability: 5,
    });
    assert.equal(g.state, 'NOT_ELIGIBLE');
  });

  it('unstable repeats stay EVALUATING', () => {
    const g = evaluateAbsenceGate({
      providerId: 'gh', liveConfirmed: 40, livePrecision: 0.97, repeatStability: 1,
    });
    assert.equal(g.state, 'EVALUATING');
  });

  it('ELIGIBLE_FOR_TRIAL only with volume, precision, stability, clean channel', () => {
    const g = evaluateAbsenceGate({
      providerId: 'greenhouse', liveConfirmed: 45, livePrecision: 0.98, repeatStability: 4,
    });
    assert.equal(g.state, 'ELIGIBLE_FOR_TRIAL');
    // Advisory only: the gate never enables the flag itself.
    assert.equal(g.recommendedFlag, false);
  });

  it('thresholds are parameters, not hidden constants', () => {
    const g = evaluateAbsenceGate({
      providerId: 'gh', liveConfirmed: 5, livePrecision: 1, repeatStability: 5, minLiveConfirmed: 5,
    });
    assert.equal(g.state, 'ELIGIBLE_FOR_TRIAL');
  });
});

describe('current provider posture (Phase 10 §6)', () => {
  it('dice and greenhouse both remain unreliable-by-declaration', async () => {
    const dice = (await import('../providers/dice.mjs')).default;
    const gh = (await import('../providers/greenhouse.mjs')).default;
    assert.equal(dice.verify?.reliableAbsence, false);
    assert.equal(gh.verify?.reliableAbsence, false);
    // And the gate agrees: with zero live confirmations, no policy change.
    for (const id of ['dice', 'greenhouse']) {
      const g = evaluateAbsenceGate({ providerId: id, liveConfirmed: 0 });
      assert.equal(g.state, 'INSUFFICIENT_DATA');
      assert.equal(g.recommendedFlag, false);
    }
  });
});
