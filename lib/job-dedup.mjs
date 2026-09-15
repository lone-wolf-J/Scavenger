// Cross-board canonical job dedup: LinkedIn + Dice + company site must
// resolve to ONE opportunity, preserving every source reference.
//
// Canonical key: normalized employer + normalized title + location area +
// posting date (day). Content-similarity fallback lives in fingerprint-core;
// this module covers the deterministic tiers (source id -> URL -> apply URL
// -> canonical key) without any network or LLM.

import { normalizeCompanyIdentity } from './company-normalize.mjs';

function normTitle(title) {
  return String(title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normLocationArea(location) {
  const loc = String(location || '').toLowerCase();
  const state = loc.match(/,\s*([a-z]{2})\b/);
  if (state) return state[1];
  if (/\bremote\b/.test(loc)) return 'remote';
  return loc.replace(/[^a-z]+/g, ' ').trim().slice(0, 40) || 'unknown';
}

function dayOf(postedAt) {
  if (typeof postedAt !== 'number' || !Number.isFinite(postedAt)) return 'undated';
  return new Date(postedAt).toISOString().slice(0, 10);
}

/** Deterministic canonical key for a job. Empty when title is missing.
 *
 * Always title-based: every board mints its own native id for the same
 * posting, so id-equality can only ever confirm a same-board re-list, never
 * a cross-board duplicate. Native ids are compared separately in
 * mergeIntoCanonical() as an additional merge signal.
 */
export function canonicalJobKey(job) {
  const title = normTitle(job?.title);
  if (!title) return '';
  const company = normalizeCompanyIdentity(job?.company) || 'unknown-employer';
  return `key:${company}::${title}::${normLocationArea(job?.location)}::${dayOf(job?.postedAt)}`;
}

/** Normalize a URL for comparison (tracking params, case, trailing slash). */
export function normalizeJobUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  try {
    const u = new URL(url.trim());
    u.hash = '';
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'refId', 'source']) {
      u.searchParams.delete(p);
    }
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Merge a job into a canonical-opportunity store.
 * @returns {{opportunity, isNew: boolean}} — opportunity.sources accumulates
 * every board that listed it.
 *
 * Merge signals (either suffices): identical title-based canonical key, or
 * identical provider-native id under the same normalized employer (catches
 * same-board re-lists whose titles were slightly reworded).
 */
export function mergeIntoCanonical(store, job) {
  const key = canonicalJobKey(job) || `url:${normalizeJobUrl(job?.url)}`;
  const native = String(job?.sourceJobId || '').trim().toLowerCase();
  const company = normalizeCompanyIdentity(job?.company) || 'unknown-employer';
  let opp = store.get(key);
  if (!opp && native) {
    for (const cand of store.values()) {
      if (cand.companyKey === company && (cand.nativeIds || []).includes(native)) {
        opp = cand;
        break;
      }
    }
  }
  const isNew = !opp;
  if (!opp) {
    opp = {
      key,
      title: job?.title || '',
      company: job?.company || '',
      companyKey: company,
      nativeIds: [],
      location: job?.location || '',
      postedAt: job?.postedAt,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      sources: [],
      urls: [],
    };
    store.set(key, opp);
  }
  opp.lastSeen = Date.now();
  if (native && !opp.nativeIds.includes(native)) opp.nativeIds.push(native);
  const src = job?.source || job?._discoverySource || 'unknown';
  if (!opp.sources.includes(src)) opp.sources.push(src);
  const url = normalizeJobUrl(job?.url);
  if (url && !opp.urls.includes(url)) opp.urls.push(url);
  return { opportunity: opp, isNew };
}
