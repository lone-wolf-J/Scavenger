import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMatchRepository } from '../lib/repositories/match-repository.mjs';
import { openOutcomeRepository } from '../lib/repositories/outcome-repository.mjs';

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'scav-measure-'));
const res = (score, band, signals = []) => ({
  score, band, reasons: [], penalties: [], matchedSignals: signals, missingSignals: [],
});

describe('outcome measurement (§10–12)', () => {
  function seeded() {
    const root = tmpRoot();
    const hp = join(root, 'h.json');
    const repo = openMatchRepository(hp);
    // j1: strong, viewed+saved (profile a); j2: weak, rejected (a); j3: strong, rejected (b)
    repo.record({ jobId: 'j1', profileId: 'a', result: res(90, 'strong', ['Workday']), job: {}, profile: {} });
    repo.record({ jobId: 'j2', profileId: 'a', result: res(50, 'weak', ['Excel']), job: {}, profile: {} });
    repo.record({ jobId: 'j3', profileId: 'b', result: res(88, 'strong', ['Workday']), job: {}, profile: {} });
    repo.viewed({ jobId: 'j1', profileId: 'a' });
    repo.outcome({ jobId: 'j1', profileId: 'a', outcome: 'saved' });
    repo.outcome({ jobId: 'j2', profileId: 'a', outcome: 'rejected' });
    repo.outcome({ jobId: 'j3', profileId: 'b', outcome: 'rejected' });
    return hp;
  }
  it('band × outcome matrix is descriptive', () => {
    const out = openOutcomeRepository(seeded(), {});
    const m = out.bandMatrix();
    assert.equal(m.strong.saved, 1);
    assert.equal(m.strong.rejected, 1);
    assert.equal(m.weak.rejected, 1);
    assert.deepEqual(Object.keys(m).sort(), ['exceptional', 'reject', 'review', 'strong', 'weak']);
  });
  it('signal table aggregates with sufficiency flags, no causality', () => {
    const out = openOutcomeRepository(seeded(), {});
    const table = out.signalTable();
    const wd = table.find((r) => r.signal === 'workday');
    assert.ok(wd && wd.samples === 2 && wd.sufficient === false); // n=2, honestly small
    assert.equal(wd.saved, 1);
  });
  it('profile counts + high-score rejection rate', () => {
    const out = openOutcomeRepository(seeded(), {});
    // j1 matched by a only in history (recorded once)... add b's view of j1
    assert.deepEqual(out.profileCounts(), { jobs: 3, byProfileCount: { 1: 3 } });
    const rej = out.highScoreRejections(75);
    assert.equal(rej.length, 1); // j3: 88 rejected
    assert.equal(rej[0].jobId, 'j3');
    assert.equal(out.highScoreRejections(95).length, 0);
  });
  it('conversion funnel + profile scoping', () => {
    const hp = seeded();
    const m = openOutcomeRepository(hp, {}).metrics();
    assert.equal(m.scored, 3);
    assert.ok(m.conversion['surfaced→viewed'] >= 0 && m.conversion['offer→hired'] === 0);
    const scoped = openOutcomeRepository(hp, { profileId: 'b' });
    assert.equal(scoped.metrics().scored, 1);
  });
});
