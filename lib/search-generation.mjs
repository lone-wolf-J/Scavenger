// Search generation — derive targeted query families from a Career Profile.
//
// No hardcoded careers: families come from the profile's own targetRoles
// (clustered by head noun), skills/technologies (boosters), and exclusions
// (+ seniority-mismatch markers). The same generator serves an HR Director,
// a Senior SWE, and a Content Strategist with zero code changes.

function words(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w && !STOP.has(w));
}

const STOP = new Set(['of', 'the', 'a', 'an', 'and', 'for', 'to', 'in', 'sr', '&']);

// Junior markers only constrain a search when the profile is mid-level+;
// a junior candidate must still find junior roles.
const JUNIOR_MARKERS = ['junior', 'intern', 'internship', 'entry level', 'entry-level', 'graduate', 'associate'];

function seniorityRank(seniority) {
  const order = ['intern', 'entry', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'head', 'vp', 'executive'];
  return order.indexOf(String(seniority || '').toLowerCase());
}

/** Head noun = last significant word ("Content Marketing Manager" → "manager"). */
function headNoun(role) {
  const w = words(role);
  return w.length ? w[w.length - 1] : '';
}

/**
 * Cluster targetRoles into families by head noun; singletons keep their own
 * family. Returns [{name, positives, seniority}] in profile order.
 */
export function clusterRolesToFamilies(targetRoles, seniority = '') {
  const roles = (Array.isArray(targetRoles) ? targetRoles : []).filter((r) => typeof r === 'string' && r.trim());
  const groups = new Map();
  for (const role of roles) {
    const head = headNoun(role) || 'general';
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(role.trim());
  }
  return [...groups.entries()].map(([head, positives]) => ({ name: head, positives, seniority }));
}

/**
 * Build full search families from a normalized Career Profile.
 * Each family: {name, positives, negatives, seniority, weight, boosters}.
 * Weight decays by family order (first family = primary).
 */
export function generateSearchFamilies(profile, { maxFamilies = 6 } = {}) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const families = clusterRolesToFamilies(p.targetRoles, p.seniority).slice(0, maxFamilies);
  const rank = seniorityRank(p.seniority);
  const negatives = [...(Array.isArray(p.exclusions) ? p.exclusions : [])];
  if (rank >= seniorityRank('mid')) {
    for (const m of JUNIOR_MARKERS) if (!negatives.includes(m)) negatives.push(m);
  }
  const boosters = [...(p.skills || []), ...(p.technologies || [])].slice(0, 8);
  return families.map((f, i) => ({
    ...f,
    negatives: [...negatives],
    boosters,
    weight: Math.round((1 - (i / Math.max(1, families.length)) * 0.5) * 100) / 100,
  }));
}

/** Render one family as a provider query string: ("A" OR "B") booster... */
export function familyQuery(family, { withBoosters = 1 } = {}) {
  const pos = (family.positives || []).map((t) => `"${t}"`).join(' OR ');
  const boost = (family.boosters || []).slice(0, withBoosters).map((b) => `"${b}"`).join(' ');
  return `(${pos})${boost ? ` ${boost}` : ''}`.trim();
}
