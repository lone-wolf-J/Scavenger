// Match + outcome repository — user match state keyed by the eventual
// logical identity userId + profileId + jobId (local seam: userId 'local').
// Delegates transitions to match-history.mjs; metrics to outcome-metrics.mjs.

import { createJsonRepository } from './json-file.mjs';
import {
  emptyHistory, recordMatch, markViewed, recordOutcome, getJobView, OUTCOMES,
} from '../match-history.mjs';
import { computeOutcomeMetrics } from '../outcome-metrics.mjs';

function normalizeHistory(parsed) {
  if (!parsed.matches || typeof parsed.matches !== 'object' || Array.isArray(parsed.matches)) return null;
  return { version: 1, matches: parsed.matches };
}

export function openMatchRepository(historyPath, userId = 'local') {
  const repo = createJsonRepository(historyPath, emptyHistory, normalizeHistory);
  return {
    path: historyPath,
    userId,
    load: () => repo.load(),
    save: (state) => repo.save(state),
    record(input) {
      const state = repo.load();
      const out = recordMatch(state, { ...input, userId: input?.userId || userId });
      repo.save(state);
      return out;
    },
    viewed(input) {
      const state = repo.load();
      const key = `${input?.profileId}::${input?.jobId}`;
      const existing = state.matches?.[key];
      if (existing && (existing.userId || 'local') !== userId) return null;
      const entry = markViewed(state, input);
      if (entry) repo.save(state);
      return entry;
    },
    outcome(input) {
      const state = repo.load();
      const key = `${input?.profileId}::${input?.jobId}`;
      const existing = state.matches?.[key];
      if (existing && (existing.userId || 'local') !== userId) {
        return { entry: existing, ok: false, reason: 'cross-tenant write rejected' };
      }
      const out = recordOutcome(state, input);
      if (out.ok) repo.save(state);
      return out;
    },
    getMatches({ userId: overrideId = null, profileId = null } = {}) {
      const effective = overrideId || userId;
      const state = repo.load();
      return Object.values(state.matches || {}).filter((e) => {
        if (!e || typeof e !== 'object') return false;
        if ((e.userId || 'local') !== effective) return false;
        if (profileId && e.profileId !== profileId) return false;
        return true;
      });
    },
    getOutcome({ userId: overrideId = null, profileId, jobId }) {
      const effective = overrideId || userId;
      const state = repo.load();
      const entry = state.matches?.[`${profileId}::${jobId}`];
      if (!entry || (entry.userId || 'local') !== effective) return null;
      return entry;
    },
    jobView({ jobId, profileIds = [] }) {
      return getJobView(repo.load(), { jobId, profileIds });
    },
    metrics() {
      return computeOutcomeMetrics(repo.load());
    },
    outcomes: OUTCOMES,
  };
}
