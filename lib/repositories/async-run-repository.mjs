// Async discovery run store — persisted run state for Web discovery that no
// longer holds the HTTP request (§7–9). One JSON file per run under
// <dir>/<runId>.json plus <runId>.input.json (profiles snapshot + options).
// Atomic writes; malformed state reads as missing (never merged).
//
// State machine (§8 — invalid transitions throw):
//   QUEUED → RUNNING → COMPLETE | PARTIAL | FAILED | CANCELLED
//   QUEUED → CANCELLED (cancel before start)
//   RUNNING → CANCELLED (via cancelRequested flag polled by the worker)
// Terminal states never transition again. No silent restarts: recovery
// marks interrupted RUNNING runs FAILED (recoverable), never re-runs them.

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createJsonRepository } from './json-file.mjs';

const TRANSITIONS = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED'],
  COMPLETE: [],
  PARTIAL: [],
  FAILED: [],
  CANCELLED: [],
};

export const RUN_STATUSES = Object.keys(TRANSITIONS);

export function assertTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    const err = new Error(`invalid run transition ${from || '(none)'} → ${to}`);
    err.code = 'INVALID_TRANSITION';
    throw err;
  }
}

/** Crash/recovery policy (§22): a RUNNING run with a dead worker is FAILED. */
export function isWorkerAlive(run, now = Date.now()) {
  if (typeof run?.pid !== 'number') return false;
  try {
    process.kill(run.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const STALE_RUNNING_MS = 10 * 60 * 1000;

export function openAsyncRunRepository(runsDir) {
  const fileFor = (runId) => join(runsDir, `${runId}.json`);
  const inputFor = (runId) => join(runsDir, `${runId}.input.json`);
  const repoFor = (runId) => createJsonRepository(fileFor(runId), () => null, (p) => (p && typeof p === 'object' && !Array.isArray(p) ? p : null));
  return {
    dir: runsDir,
    inputPath: (runId) => inputFor(runId),
    create({ runId, profiles, options, idempotencyKey = null, now = Date.now() }) {
      const stamp = new Date(now).toISOString();
      // State holds profile REFERENCES only (ids/names) — never profile
      // objects, resume text, or PII. Full profiles live transiently in the
      // input file the worker consumes, then deleted at terminal state.
      const refs = (Array.isArray(profiles) ? profiles : []).map((p) => ({
        id: String(p?.id || ''),
        name: typeof p?.name === 'string' ? p.name : String(p?.id || ''),
      }));
      const state = {
        runId, status: 'QUEUED', stage: 'QUEUED',
        profiles: refs,
        options: options && typeof options === 'object' ? options : {},
        idempotencyKey,
        pid: null, cancelRequested: false,
        providers: {}, funnel: null, matchesSummary: null,
        errors: [], timings: null,
        createdAt: stamp, updatedAt: stamp, startedAt: null, completedAt: null,
      };
      repoFor(runId).save(state);
      return state;
    },
    get: (runId) => repoFor(runId).load(),
    update(runId, patch) {
      const repo = repoFor(runId);
      const state = repo.load();
      if (!state) {
        const err = new Error(`unknown run "${runId}"`);
        err.code = 'UNKNOWN_RUN';
        throw err;
      }
      if (patch.status && patch.status !== state.status) assertTransition(state.status, patch.status);
      Object.assign(state, patch, { updatedAt: new Date().toISOString() });
      repo.save(state);
      return state;
    },
    transition(runId, to, patch = {}) {
      const repo = repoFor(runId);
      const state = repo.load();
      if (!state) {
        const err = new Error(`unknown run "${runId}"`);
        err.code = 'UNKNOWN_RUN';
        throw err;
      }
      assertTransition(state.status, to);
      Object.assign(state, patch, { status: to, updatedAt: new Date().toISOString() });
      repo.save(state);
      return state;
    },
    /** Active (QUEUED/RUNNING) run with the same idempotency key, if any. */
    findActiveByKey(idempotencyKey) {
      if (!idempotencyKey || !existsSync(runsDir)) return null;
      for (const f of readdirSync(runsDir)) {
        if (!f.endsWith('.json') || f.endsWith('.input.json')) continue;
        const state = repoFor(f.slice(0, -'.json'.length)).load();
        if (state && (state.status === 'QUEUED' || state.status === 'RUNNING') && state.idempotencyKey === idempotencyKey) {
          return state;
        }
      }
      return null;
    },
    /** Recovery scan (§22): stale RUNNING runs → FAILED (recoverable). */
    recover(now = Date.now()) {
      const recovered = [];
      if (!existsSync(runsDir)) return recovered;
      for (const f of readdirSync(runsDir)) {
        if (!f.endsWith('.json') || f.endsWith('.input.json')) continue;
        const runId = f.slice(0, -'.json'.length);
        const repo = repoFor(runId);
        const state = repo.load();
        if (!state || state.status !== 'RUNNING') continue;
        const stale = now - Date.parse(state.updatedAt || 0) > STALE_RUNNING_MS;
        if ((state.pid != null && !isWorkerAlive(state)) || stale) {
          state.status = 'FAILED';
          state.stage = 'FAILED';
          state.updatedAt = new Date(now).toISOString();
          state.completedAt = state.completedAt || new Date(now).toISOString();
          state.errors = [...(state.errors || []), { provider: 'worker', errorType: 'INTERRUPTED', message: 'worker process ended mid-run; safe to retry (canonical store untouched by partial work beyond committed upserts)' }];
          state.recoverable = true;
          repo.save(state);
          recovered.push(runId);
        }
      }
      return recovered;
    },
    list(limit = 20) {
      if (!existsSync(runsDir)) return [];
      const out = [];
      for (const f of readdirSync(runsDir)) {
        if (!f.endsWith('.json') || f.endsWith('.input.json')) continue;
        const state = repoFor(f.slice(0, -'.json'.length)).load();
        if (state) out.push(state);
      }
      return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
    },
  };
}
