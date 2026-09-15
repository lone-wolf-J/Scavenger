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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

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
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
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
    const p = cachePath(dataRoot, providerId);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2) + '\n', 'utf-8');
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
