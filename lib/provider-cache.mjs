// Provider-level cache: avoid re-fetching identical data.
//
// Stores per-provider state under data/cache/providers/<id>.json:
//   { lastSuccess, lastFailure, cursor, lastJobIds, rateLimit, jobCount }
//
// - TTL-gated reads: fresh cache entries can satisfy a scan without HTTP.
// - Dry-run safe: loadCache() reads, saveCache() is skipped by the caller
//   when dryRun is set (scan.mjs enforces this).
// - All I/O is best-effort: a corrupt cache file reads as empty, a failed
//   write never throws.
//
// CACHE PRIVACY INVARIANT (§17): cache values hold provider job listings
// only — raw postings as returned by the board. Never stored here: resumes,
// profile objects, personal information (names, emails, phones), match
// history, user outcomes, or scoring data. The engine only ever passes
// provider fetch results into recordSuccess(); there is no code path that
// merges user/profile state into a cache slot. A test pins this
// (tests/cache-privacy.test.mjs: forbidden top-level keys per snapshot).

import { existsSync } from 'fs';
import path from 'path';
import { atomicWriteJson, readJsonStrict } from './atomic-write.mjs';
export const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function cachePath(dataRoot, providerId) {
  const safe = String(providerId || 'unknown').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 120);
  return path.join(dataRoot, 'data', 'cache', 'providers', `${safe}.json`);
}

/**
 * Scope a cache slot to one scan target. Provider ids are shared across
 * tenants (100 Greenhouse companies share provider 'greenhouse'), so the
 * slot must include the entry identity or tenant B would read tenant A's
 * cached jobs.
 */
export function cacheScope(providerId, entry = {}) {
  const ident = entry.careers_url || entry.api || entry.query || entry.name || 'default';
  const slug = String(ident).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'default';
  return `${providerId}--${slug}`;
}

export function loadCache(dataRoot, providerId) {
  try {
    const p = cachePath(dataRoot, providerId);
    if (!existsSync(p)) return null;
    const parsed = readJsonStrict(p); // malformed → null, never merged
    return parsed && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isFresh(entry, ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
  if (!entry || typeof entry.lastSuccess !== 'number') return false;
  return now - entry.lastSuccess < ttlMs;
}

export function saveCache(dataRoot, providerId, state) {
  try {
    atomicWriteJson(cachePath(dataRoot, providerId), { ...state, savedAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

export function recordSuccess(dataRoot, providerId, { jobIds = [], cursor = null, jobCount = 0, jobsSnapshot = null } = {}) {
  const snapshot = Array.isArray(jobsSnapshot)
    ? jobsSnapshot.slice(0, 200).map((j) => {
      if (!j || typeof j !== 'object') return j;
      const copy = { ...j };
      // Bound slot size: descriptions can be large; 2k chars keeps every
      // description-based filter (content/visa/country) fully functional.
      if (typeof copy.description === 'string' && copy.description.length > 2000) {
        copy.description = copy.description.slice(0, 2000);
      }
      return copy;
    })
    : undefined;
  return saveCache(dataRoot, providerId, {
    ...loadCache(dataRoot, providerId),
    lastSuccess: Date.now(),
    lastFailure: null,
    cursor,
    lastJobIds: jobIds.slice(0, 500),
    jobCount,
    ...(snapshot ? { jobsSnapshot: snapshot } : {}),
  });
}

export function recordFailure(dataRoot, providerId, { errorType = '', message = '' } = {}) {
  return saveCache(dataRoot, providerId, {
    ...loadCache(dataRoot, providerId),
    lastFailure: { at: Date.now(), errorType, message: String(message).slice(0, 500) },
  });
}
