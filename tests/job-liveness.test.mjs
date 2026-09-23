import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSERVED_ACTIVE, OBSERVED_CLOSED, STALE, UNKNOWN,
  assertClosedEvidence, makeClosedEvidence, classifyObservation,
  safeForClosure, diffConsecutiveRuns, applyLiveness,
} from '../lib/job-liveness.mjs';
import { emptyStore, upsertJobs } from '../lib/job-store.mjs';

const NOW = Date.now();
const DAY = 86_400_000;
const REC = { jobId: 'k', title: 'T', lastSeen: NOW - DAY };

describe('job liveness (§5–6, §16)', () => {
  it('closed-evidence schema: valid passes, invalid rejected with reasons', () => {
    assert.equal(assertClosedEvidence(null).ok, false);
    assert.equal(assertClosedEvidence({}).ok, false);
    assert.ok(assertClosedEvidence({ type: 'nope', confidence: 'high', reason: 'x', observedAt: new Date(NOW).toISOString() }).reason.includes('type'));
    assert.ok(assertClosedEvidence({ type: 'explicit-provider', confidence: 'low', reason: 'x', observedAt: new Date(NOW).toISOString() }).reason.includes('confidence'));
    assert.ok(assertClosedEvidence({ type: 'explicit-provider', confidence: 'high', reason: '  ', observedAt: new Date(NOW).toISOString() }).reason.includes('reason'));
    assert.ok(assertClosedEvidence({ type: 'explicit-provider', confidence: 'high', reason: 'x', observedAt: 'yesterday' }).reason.includes('observedAt'));
    assert.ok(assertClosedEvidence({ type: 'explicit-provider', confidence: 'high', reason: 'x', observedAt: new Date(NOW).toISOString() }).reason.includes('provider'));
    const good = assertClosedEvidence({ type: 'explicit-provider', provider: 'dice', confidence: 'high', reason: '410 Gone', observedAt: new Date(NOW).toISOString() });
    assert.equal(good.ok, true);
    // clock/manual need no provider — distinguishable by type
    assert.equal(assertClosedEvidence({ type: 'clock', confidence: 'medium', reason: 'aged out', observedAt: new Date(NOW).toISOString() }).ok, true);
    assert.throws(() => makeClosedEvidence({ type: 'bogus', reason: 'x' }), /invalid closedEvidence/);
    const made = makeClosedEvidence({ type: 'manual', confidence: 'high', reason: 'user confirmed', now: NOW });
    assert.equal(made.observedAt, new Date(NOW).toISOString());
  });

  it('observation states: active / closed / stale / unknown', () => {
    assert.equal(classifyObservation(REC, { observed: true, runStatus: 'COMPLETE', now: NOW }).state, OBSERVED_ACTIVE);
    assert.equal(classifyObservation(REC, { observed: true, runStatus: 'PARTIAL', now: NOW }).state, OBSERVED_ACTIVE);
    assert.equal(classifyObservation(null, { now: NOW }).state, UNKNOWN);
    assert.equal(classifyObservation({ jobId: 'x' }, { now: NOW }).state, UNKNOWN);
    const stale = classifyObservation({ ...REC, lastSeen: NOW - 60 * DAY }, { observed: false, runStatus: 'COMPLETE', now: NOW });
    assert.equal(stale.state, STALE);
    const ev = makeClosedEvidence({ type: 'verified-detail', provider: 'greenhouse', reason: 'detail 404', now: NOW });
    assert.equal(classifyObservation(REC, { closedEvidence: ev, now: NOW }).state, OBSERVED_CLOSED);
    assert.equal(classifyObservation(REC, { closedEvidence: { nope: 1 }, now: NOW }).state, UNKNOWN);
  });

  it('provider failure is never closure evidence', () => {
    for (const failure of ['BLOCKED', 'UNSUPPORTED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'ERROR', 'TEMPORARILY_UNAVAILABLE']) {
      // Failure strings are not valid evidence objects — always rejected.
      assert.equal(assertClosedEvidence({ type: failure, reason: 'x', observedAt: new Date(NOW).toISOString(), confidence: 'high' }).ok, false);
    }
    // A recently seen job stays active even when its provider errored.
    assert.equal(classifyObservation(REC, { observed: false, runStatus: 'COMPLETE', now: NOW }).state, OBSERVED_ACTIVE);
    assert.equal(safeForClosure('FAILED'), false);
    assert.equal(safeForClosure('PARTIAL'), false);
    assert.equal(safeForClosure('COMPLETE'), true);
  });

  it('consecutive diffs require two COMPLETE runs', () => {
    const a = { status: 'COMPLETE', observedJobIds: ['1', '2', '3'] };
    const b = { status: 'COMPLETE', observedJobIds: ['2', '3', '4'] };
    assert.deepEqual(diffConsecutiveRuns(a, b), { new: ['4'], unchanged: ['2', '3'], missing: ['1'] });
    assert.ok(diffConsecutiveRuns(a, { ...b, status: 'PARTIAL' }).error.includes('COMPLETE'));
    assert.ok(diffConsecutiveRuns(null, b).error);
  });

  it('applyLiveness preserves history: close keeps everything, invalid rejected', () => {
    const store = emptyStore();
    upsertJobs(store, [{ title: 'T', company: 'C', url: 'https://j/1', source: 'dice' }], NOW);
    const id = Object.keys(store.jobs)[0];
    const before = JSON.stringify({ s: store.jobs[id].sources, f: store.jobs[id].firstSeen });
    const ev = makeClosedEvidence({ type: 'explicit-provider', provider: 'dice', reason: 'board reports removed', now: NOW });
    const r = applyLiveness(store, id, { state: OBSERVED_CLOSED, reason: ev.reason, evidence: ev }, NOW);
    assert.equal(r.applied, true);
    const rec = store.jobs[id];
    assert.equal(rec.lifecycle, 'closed');
    assert.deepEqual(rec.closedEvidence, ev);
    assert.equal(JSON.stringify({ s: rec.sources, f: rec.firstSeen }), before); // history intact
    assert.equal(applyLiveness(store, id, { state: OBSERVED_CLOSED, evidence: { bad: 1 } }, NOW).applied, false);
    assert.equal(applyLiveness(store, 'ghost', { state: OBSERVED_CLOSED, evidence: ev }, NOW).applied, false);
    // Re-observation of an evidence-closed job does not silently reopen it
    // (upsertJobs has the same guard); only active records refresh.
    const r2 = applyLiveness(store, id, { state: OBSERVED_ACTIVE, reason: 'seen' }, NOW + 1);
    assert.equal(r2.applied, true);
    assert.equal(store.jobs[id].lifecycle, 'closed'); // evidence wins
  });
});
