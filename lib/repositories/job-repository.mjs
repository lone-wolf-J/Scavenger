// Job repository — canonical jobs behind get/upsert/list, never raw JSON.
// Delegates all identity/diff/lifecycle logic to job-store.mjs + job-diff.mjs.

import { createJsonRepository } from './json-file.mjs';
import {
  emptyStore, jobIdFor, getJob, upsertJobs,
} from '../job-store.mjs';
import { descriptionHash } from '../job-diff.mjs';
import { refreshLifecycle, classifyLifecycle } from '../job-diff.mjs';

function normalizeStore(parsed) {
  if (!parsed.jobs || typeof parsed.jobs !== 'object' || Array.isArray(parsed.jobs)) return null;
  // Same backward-compat defaults as job-store.loadStore: pre-lifecycle
  // records gain lifecycle/descriptionHash/sources in place.
  for (const record of Object.values(parsed.jobs)) {
    if (record && typeof record === 'object') {
      if (!record.lifecycle) { record.lifecycle = 'active'; record.lifecycleAt = null; }
      if (!record.descriptionHash) {
        record.descriptionHash = descriptionHash(typeof record.description === 'string' ? record.description : '');
      }
      if (!Array.isArray(record.sources)) record.sources = record.source ? [record.source] : [];
    }
  }
  return { version: 1, jobs: parsed.jobs };
}

export function openJobRepository(storePath) {
  const repo = createJsonRepository(storePath, emptyStore, normalizeStore);
  return {
    path: storePath,
    load: () => repo.load(),
    save: (state) => repo.save(state),
    get: (jobId) => getJob(repo.load(), jobId),
    list: () => Object.values(repo.load().jobs || {}),
    count: () => Object.keys(repo.load().jobs || {}).length,
    upsert(jobs, now = Date.now()) {
      const state = repo.load();
      const result = upsertJobs(state, jobs, now);
      repo.save(state);
      return result;
    },
    refreshLifecycle(opts = {}) {
      const state = repo.load();
      const result = refreshLifecycle(state, opts);
      repo.save(state);
      return result;
    },
    lifecycleOf: (jobId, opts = {}) => classifyLifecycle(getJob(repo.load(), jobId), opts),
  };
}

export { jobIdFor };
