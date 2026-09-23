// Scavenger intelligence feed (§6) — derived from persisted data only.
//
// Item types: NEW | CHANGED | MATCH_IMPROVED | STALE | PROFILE_MULTI.
// Every item references real store/history records; nothing is synthesized.
// Inputs are all already-persisted state: the canonical store, the match
// history, the latest run record, and the previous run's match snapshot.

/**
 * @param {object} opts
 * @param {object} opts.store - job-store state
 * @param {object} opts.history - match-history state
 * @param {object} [opts.run] - latest discovery run record ({completedAt, ...})
 * @param {Array} [opts.changes] - diffJobs-style [{jobId, changedFields}] from this run
 * @param {number} [opts.now]
 * @param {number} [opts.strongThreshold] - default 75
 * @returns {Array<{type, jobId, title, company, detail, profileIds, at}>}
 */
export function buildChangeFeed({ store, history, run = null, changes = [], now = Date.now(), strongThreshold = 75 } = {}) {
  const items = [];
  const jobs = store?.jobs || {};
  const matches = history?.matches || {};
  const since = run?.completedAt ? Date.parse(run.completedAt) : 0;

  // NEW: firstSeen after the run started (or all recent when no run).
  for (const [id, job] of Object.entries(jobs)) {
    if (typeof job?.firstSeen !== 'number') continue;
    if (since && job.firstSeen <= since) continue;
    if (!since && now - job.firstSeen > 7 * 86_400_000) continue;
    items.push({
      type: 'NEW', jobId: id, title: job.title || '', company: job.company || '',
      detail: `first seen ${new Date(job.firstSeen).toLocaleDateString()}`,
      profileIds: [], at: new Date(job.firstSeen).toISOString(),
    });
  }

  // CHANGED: meaningful diffs from this run.
  for (const change of Array.isArray(changes) ? changes : []) {
    const job = jobs[change.jobId];
    if (!job) continue;
    items.push({
      type: 'CHANGED', jobId: change.jobId, title: job.title || '', company: job.company || '',
      detail: `changed: ${(change.changedFields || []).join(', ')}`,
      profileIds: [], at: new Date(now).toISOString(),
    });
  }

  // MATCH_IMPROVED + PROFILE_MULTI + per-profile state from history.
  const byJob = new Map();
  for (const entry of Object.values(matches)) {
    if (!entry || typeof entry !== 'object' || !entry.jobId) continue;
    if (!byJob.has(entry.jobId)) byJob.set(entry.jobId, []);
    byJob.get(entry.jobId).push(entry);
  }
  for (const [jobId, entries] of byJob) {
    const job = jobs[jobId];
    if (!job) continue;
    const improved = entries.filter((e) => e.scoreChanged && typeof e.score === 'number' && e.score >= strongThreshold);
    if (improved.length) {
      items.push({
        type: 'MATCH_IMPROVED', jobId, title: job.title || '', company: job.company || '',
        detail: `stronger matches for ${improved.map((e) => e.profileId).join(', ')}`,
        profileIds: improved.map((e) => e.profileId),
        at: entries.map((e) => e.updatedAt || '').sort().pop() || new Date(now).toISOString(),
      });
    }
    const strongProfiles = entries.filter((e) => typeof e.score === 'number' && e.score >= strongThreshold).map((e) => e.profileId);
    if (strongProfiles.length >= 2) {
      items.push({
        type: 'PROFILE_MULTI', jobId, title: job.title || '', company: job.company || '',
        detail: `matches ${strongProfiles.length} profiles strongly`,
        profileIds: strongProfiles,
        at: new Date(now).toISOString(),
      });
    }
  }

  // STALE: lifecycle stale, not yet acted on.
  for (const [id, job] of Object.entries(jobs)) {
    if (job?.lifecycle !== 'stale') continue;
    const acted = [...(byJob.get(id) || [])].some((e) => e.viewed || (e.outcome && e.outcome !== 'surfaced'));
    if (acted) continue;
    items.push({
      type: 'STALE', jobId: id, title: job.title || '', company: job.company || '',
      detail: `not seen since ${job.lastSeen ? new Date(job.lastSeen).toLocaleDateString() : 'unknown'}`,
      profileIds: [], at: new Date(now).toISOString(),
    });
  }

  const order = { NEW: 0, CHANGED: 1, MATCH_IMPROVED: 2, PROFILE_MULTI: 3, STALE: 4 };
  return items.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || String(b.at).localeCompare(String(a.at)));
}

/** Headline counts for "since your last search" UX. */
export function feedSummary(items) {
  const count = (t) => items.filter((i) => i.type === t).length;
  return {
    new: count('NEW'),
    changed: count('CHANGED'),
    improved: count('MATCH_IMPROVED'),
    stale: count('STALE'),
    multiProfile: count('PROFILE_MULTI'),
    total: items.length,
  };
}
