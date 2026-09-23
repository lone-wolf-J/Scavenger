#!/usr/bin/env node
// Detached discovery worker (§7): executes one async run started by the Web
// API without holding the HTTP request. CLI keeps using the engine directly
// and synchronously — this file exists only so HTTP doesn't.
//
//   node lib/discovery-worker.mjs <runsDir> <runId>
//
// Reads <runId>.input.json {profiles, options, dataRoot, jobStorePath,
// runsPath, userId}, transitions QUEUED→RUNNING, streams progress into the
// run file, then marks COMPLETE/PARTIAL/FAILED/CANCELLED. Never throws
// past main(): every failure path persists FAILED first. No silent restart:
// a dead worker is detected by the status reader (stale heartbeat / dead
// PID) and marked FAILED recoverable.

import { readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { openAsyncRunRepository } from './repositories/async-run-repository.mjs';
import { isMainModule } from './is-main-module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Remove the transient input file once a run is terminal (privacy §19). */
function dropInput(runsDir, runId) {
  try {
    unlinkSync(join(runsDir, `${runId}.input.json`));
  } catch { /* already gone — fine */ }
}

export async function runAsyncDiscovery({ runsDir, runId, engineModules = null, now = Date.now() }) {
  const repos = openAsyncRunRepository(runsDir);
  const readInput = async () => {
    const raw = readFileSync(repos.inputPath(runId), 'utf-8');
    return JSON.parse(raw);
  };
  const engine = engineModules || await import('./discovery-engine.mjs');
  const input = await readInput();
  const providers = Array.isArray(input.options?.providers) && input.options.providers.length
    ? input.options.providers
    : [...(engine.DEFAULT_BOARD_PROVIDERS || [])];
  let state = repos.transition(runId, 'RUNNING', {
    stage: 'SEARCHING',
    pid: process.pid,
    startedAt: new Date(now).toISOString(),
    providers: Object.fromEntries(providers.map((id) => [id, { status: 'RUNNING' }])),
  });
  const cancelCheck = () => {
    try {
      const cur = repos.get(runId);
      return cur?.cancelRequested === true;
    } catch {
      return false;
    }
  };
  const onProgress = (info) => {
    try {
      const cur = repos.get(runId);
      if (!cur || cur.status !== 'RUNNING') return;
      cur.stage = info.stage;
      cur.updatedAt = new Date().toISOString();
      repos.update(runId, { stage: cur.stage });
    } catch { /* progress must never break discovery */ }
  };
  try {
    const result = await engine.discoverForProfiles({
      profiles: input.profiles,
      providers,
      maxAgeDays: input.options?.maxAgeDays,
      maxQueries: input.options?.maxQueries,
      maxPages: input.options?.maxPages,
      refresh: input.options?.refresh === true,
      dataRoot: input.dataRoot,
      jobStorePath: input.jobStorePath,
      runsPath: input.runsPath,
      userId: input.userId || 'local',
      now,
      onProgress,
      cancelCheck,
    });
    const providerStates = {};
    for (const p of result.providers || []) {
      providerStates[p.id] = {
        status: p.status, raw: p.raw, normalized: p.normalized || 0,
        accepted: p.accepted, dupes: p.dupes, highMatch: p.highMatch,
        runtimeMs: p.runtimeMs, error: p.lastErrorType || null,
      };
    }
    state = repos.transition(runId, result.status === 'FAILED' ? 'FAILED' : result.status === 'PARTIAL' ? 'PARTIAL' : 'COMPLETE', {
      stage: result.status,
      completedAt: result.completedAt,
      providers: providerStates,
      funnel: result.funnel,
      matchesByProfile: result.matchesByProfile,
      observedJobIds: result.observedJobIds,
      missingJobIds: result.missingJobIds,
      timings: result.timings,
      errors: result.errors,
      summary: {
        accepted: result.jobsAccepted,
        added: result.jobsPersisted?.added ?? 0,
        updated: result.jobsPersisted?.updated ?? 0,
        changed: (result.changes || []).length,
        strong: (result.matches || []).filter((m) => (m.best?.score ?? 0) >= 75).length,
      },
    });
    dropInput(runsDir, runId);
    return { runId, status: state.status };
  } catch (err) {
    if (err?.code === 'CANCELLED' || /cancel/i.test(err?.message || '')) {
      state = repos.transition(runId, 'CANCELLED', { stage: 'CANCELLED', completedAt: new Date().toISOString() });
      dropInput(runsDir, runId);
      return { runId, status: 'CANCELLED' };
    }
    state = repos.transition(runId, 'FAILED', {
      stage: 'FAILED',
      completedAt: new Date().toISOString(),
      errors: [...(repos.get(runId)?.errors || []), { provider: 'worker', errorType: 'WORKER_ERROR', message: String(err?.message || err) }],
    });
    dropInput(runsDir, runId);
    return { runId, status: 'FAILED' };
  }
}

if (isMainModule(import.meta.url)) {
  const [runsDir, runId] = process.argv.slice(2);
  if (!runsDir || !runId) {
    console.error('usage: node lib/discovery-worker.mjs <runsDir> <runId>');
    process.exit(2);
  }
  const out = await runAsyncDiscovery({ runsDir, runId }).catch((err) => {
    console.error(`worker fatal: ${err?.message || err}`);
    process.exitCode = 1;
    return null;
  });
  process.exitCode = out && out.status !== 'FAILED' ? 0 : 1;
}
