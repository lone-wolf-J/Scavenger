// Discovery-run repository — durable structured run history (§1).
// Same record shape the engine writes; readers get newest-first lists and
// consecutive-run pairs for diffing. Writes stay atomic via json-file.

import { createJsonRepository } from './json-file.mjs';

const MAX_RUNS = 50;

function normalizeRuns(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.runs)) return null;
  return { runs: parsed.runs };
}

export function openDiscoveryRunRepository(runsPath) {
  const repo = createJsonRepository(runsPath, () => ({ runs: [] }), normalizeRuns);
  return {
    path: runsPath,
    load: () => repo.load(),
    save: (state) => repo.save(state),
    append(run) {
      const state = repo.load();
      state.runs.push(run);
      state.runs = state.runs.slice(-MAX_RUNS);
      repo.save(state);
      return run;
    },
    recent: (n = 10) => repo.load().runs.slice(-n).reverse(),
    /** Latest run with the given status (COMPLETE default skips PARTIAL/FAILED). */
    latest: (status = 'COMPLETE') => {
      const runs = repo.load().runs;
      for (let i = runs.length - 1; i >= 0; i--) {
        if (runs[i]?.status === status) return runs[i];
      }
      return null;
    },
    /**
     * Consecutive successful runs for diffing: the newest COMPLETE run and
     * the COMPLETE run before it. PARTIAL/FAILED runs are never used as a
     * diff base — absence in a partial run proves nothing (§8, §16).
     */
    consecutiveComplete: () => {
      const complete = repo.load().runs.filter((r) => r?.status === 'COMPLETE');
      if (complete.length < 2) return { previous: null, current: complete[complete.length - 1] || null };
      return { previous: complete[complete.length - 2], current: complete[complete.length - 1] };
    },
  };
}
