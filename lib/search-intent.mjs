// Search intent — one retrieval for many profiles (Phase 4 §7, §20).
//
// Selected profiles → per-profile families (search-generation) → merged,
// deduplicated query list. The provider layer executes the merged list ONCE;
// the resulting shared jobs are then matched against every selected profile.
// Queries are provider-agnostic strings; binding them to a provider's query
// syntax happens at retrieval time, not here.

import { normalizeCareerProfile } from './career-profile.mjs';
import { generateSearchFamilies, familyQuery } from './search-generation.mjs';

const normQ = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * @param {Array<{id: string, profile: object}>} selected - active profiles
 * @returns {{byProfile: Array<{profileId, families}>, queries: string[]}}
 */
export function buildSearchIntent(selected, { withBoosters = 1 } = {}) {
  const byProfile = [];
  const seen = new Set();
  const queries = [];
  for (const { id, profile } of Array.isArray(selected) ? selected : []) {
    const families = generateSearchFamilies(normalizeCareerProfile(profile));
    byProfile.push({ profileId: id, families });
    for (const family of families) {
      const q = familyQuery(family, { withBoosters });
      const key = normQ(q);
      if (key && !seen.has(key)) {
        seen.add(key);
        queries.push(q);
      }
    }
  }
  return { byProfile, queries };
}

/**
 * Count retrieval cost of an intent: unique provider-bound queries.
 * Retrieval MUST be called once per unique query regardless of how many
 * profiles selected it — this helper is what tests assert sharing on.
 */
export function retrievalPlan(intent) {
  const queries = [...new Set((intent?.queries || []).map((q) => normQ(q)).filter(Boolean))];
  return { queryCount: queries.length, queries };
}
