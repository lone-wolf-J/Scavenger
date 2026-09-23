import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncRunRepository, assertTransition, RUN_STATUSES } from '../lib/repositories/async-run-repository.mjs';
import { runAsyncDiscovery } from '../lib/discovery-worker.mjs';

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'scav-async-'));

describe('async run state machine (§8)', () => {
  it('valid transitions pass, invalid throw with code', () => {
    assertTransition('QUEUED', 'RUNNING');
    assertTransition('RUNNING', 'COMPLETE');
    assertTransition('RUNNING', 'PARTIAL');
    assertTransition('RUNNING', 'FAILED');
    assertTransition('RUNNING', 'CANCELLED');
    assertTransition('QUEUED', 'CANCELLED');
    for (const bad of [['COMPLETE', 'RUNNING'], ['FAILED', 'RUNNING'], ['CANCELLED', 'RUNNING'], ['QUEUED', 'COMPLETE'], ['COMPLETE', 'FAILED']]) {
      assert.throws(() => assertTransition(bad[0], bad[1]), (e) => e.code === 'INVALID_TRANSITION');
    }
    assert.ok(RUN_STATUSES.includes('QUEUED') && RUN_STATUSES.includes('CANCELLED'));
  });

  it('CRUD + cancel flows + unknown run errors', () => {
    const repos = openAsyncRunRepository(tmpRoot());
    const r = repos.create({ runId: 'r1', profiles: [{ id: 'a', name: 'A' }], options: {}, now: 1000 });
    assert.equal(r.status, 'QUEUED');
    assert.equal(repos.get('r1').status, 'QUEUED');
    assert.equal(repos.get('nope'), null);
    repos.transition('r1', 'RUNNING', { pid: 12345 });
    assert.throws(() => repos.transition('r1', 'QUEUED'), (e) => e.code === 'INVALID_TRANSITION');
    assert.throws(() => repos.transition('ghost', 'RUNNING'), (e) => e.code === 'UNKNOWN_RUN');
    repos.transition('r1', 'CANCELLED', {});
    assert.equal(repos.get('r1').status, 'CANCELLED');
    assert.throws(() => repos.transition('r1', 'RUNNING'), (e) => e.code === 'INVALID_TRANSITION');
    assert.deepEqual(repos.list().map((x) => x.runId), ['r1']);
  });

  it('duplicate protection returns the active run', () => {
    const repos = openAsyncRunRepository(tmpRoot());
    repos.create({ runId: 'r1', profiles: [], options: {}, idempotencyKey: 'k1' });
    repos.transition('r1', 'RUNNING', {});
    assert.equal(repos.findActiveByKey('k1').runId, 'r1');
    assert.equal(repos.findActiveByKey('other'), null);
    repos.transition('r1', 'COMPLETE', {});
    assert.equal(repos.findActiveByKey('k1'), null); // terminal: no longer active
  });
});

describe('crash recovery (§22)', () => {
  it('dead pid + stale heartbeat → FAILED recoverable; live runs untouched', () => {
    const repos = openAsyncRunRepository(tmpRoot());
    const now = 1_000_000;
    repos.create({ runId: 'dead', profiles: [], options: {}, now });
    repos.transition('dead', 'RUNNING', { pid: 987654321 });
    // Fresh RUNNING run with a live pid stand-in: use our own pid (alive).
    repos.create({ runId: 'live', profiles: [], options: {}, now });
    repos.transition('live', 'RUNNING', { pid: process.pid });
    const rec = repos.recover(now + 60_000);
    assert.deepEqual(rec, ['dead']);
    const dead = repos.get('dead');
    assert.equal(dead.status, 'FAILED');
    assert.equal(dead.recoverable, true);
    assert.ok(dead.errors.some((e) => e.errorType === 'INTERRUPTED'));
    assert.equal(repos.get('live').status, 'RUNNING'); // alive pid + fresh heartbeat
  });

  it('stale heartbeat with dead pid also recovers (either signal suffices)', () => {
    const repos = openAsyncRunRepository(tmpRoot());
    const now = 1_000_000;
    repos.create({ runId: 'old', profiles: [], options: {}, now: now - 20 * 60_000 });
    repos.transition('old', 'RUNNING', { pid: 987654321 });
    assert.deepEqual(repos.recover(now), ['old']);
  });

  it('QUEUED runs never touched by recovery', () => {
    const repos = openAsyncRunRepository(tmpRoot());
    repos.create({ runId: 'q', profiles: [], options: {} });
    assert.deepEqual(repos.recover(Date.now()), []);
    assert.equal(repos.get('q').status, 'QUEUED');
  });
});

describe('worker execution (mocked engine)', () => {
  const input = (dir, extra = {}) => ({
    profiles: [{ id: 'a', profile: { targetRoles: ['Engineer'] } }],
    options: {},
    dataRoot: dir,
    jobStorePath: join(dir, 'job-store.json'),
    runsPath: join(dir, 'discovery-runs.json'),
    userId: 'local',
    ...extra,
  });

  it('full success path persists terminal state + deletes input', async () => {
    const dir = tmpRoot();
    const repos = (await import('../lib/repositories/async-run-repository.mjs')).openAsyncRunRepository(dir);
    const { writeFileSync, existsSync } = await import('node:fs');
    repos.create({ runId: 'w1', profiles: [{ id: 'a', name: 'A' }], options: {} });
    writeFileSync(repos.inputPath('w1'), JSON.stringify(input(dir)));
    const fakeEngine = {
      DEFAULT_BOARD_PROVIDERS: ['dice'],
      async discoverForProfiles() {
        return {
          status: 'COMPLETE', completedAt: new Date().toISOString(),
          funnel: { raw: 2, us: 2, fresh: 2, unique: 1 },
          matchesByProfile: { a: { matched: 1 } },
          observedJobIds: ['k1'], missingJobIds: [],
          timings: { totalMs: 5 }, errors: [],
          providers: [{ id: 'dice', status: 'ACTIVE', raw: 2, accepted: 1, dupes: 1, highMatch: 0, runtimeMs: 4 }],
        };
      },
    };
    const out = await runAsyncDiscovery({ runsDir: dir, runId: 'w1', engineModules: fakeEngine });
    assert.equal(out.status, 'COMPLETE');
    const st = repos.get('w1');
    assert.equal(st.status, 'COMPLETE');
    assert.equal(st.funnel.unique, 1);
    assert.ok(typeof st.pid === 'number');
    assert.equal(existsSync(repos.inputPath('w1')), false); // transient input removed
  });

  it('engine throw → FAILED; cancel flag → CANCELLED', async () => {
    const dir = tmpRoot();
    const repos = (await import('../lib/repositories/async-run-repository.mjs')).openAsyncRunRepository(dir);
    const { writeFileSync } = await import('node:fs');
    const boomEngine = { DEFAULT_BOARD_PROVIDERS: [], async discoverForProfiles() { throw new Error('kaput'); } };
    repos.create({ runId: 'w2', profiles: [], options: {} });
    writeFileSync(repos.inputPath('w2'), JSON.stringify(input(dir)));
    assert.equal((await runAsyncDiscovery({ runsDir: dir, runId: 'w2', engineModules: boomEngine })).status, 'FAILED');
    assert.equal(repos.get('w2').status, 'FAILED');

    const cancelEngine = {
      DEFAULT_BOARD_PROVIDERS: [],
      async discoverForProfiles(opts) {
        assert.equal(opts.cancelCheck(), true);
        const err = new Error('cancel requested');
        err.code = 'CANCELLED';
        throw err;
      },
    };
    repos.create({ runId: 'w3', profiles: [], options: {} });
    writeFileSync(repos.inputPath('w3'), JSON.stringify(input(dir)));
    // Pre-arm the flag: worker picks it up on first poll.
    repos.update('w3', { cancelRequested: true });
    const out = await runAsyncDiscovery({ runsDir: dir, runId: 'w3', engineModules: cancelEngine });
    assert.equal(out.status, 'CANCELLED');
  });
});
