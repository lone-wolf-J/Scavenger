// Career Profile abstraction — the user-specific half of the architecture.
//
// JOB INTELLIGENCE (domain-neutral: sources, normalization, filtering,
// dedup, employer resolution) ≠ CAREER PROFILE (user-specific: roles,
// skills, seniority, prefs). The same normalized job is evaluated against
// any Career Profile; a new career domain must never require code changes.
//
// A profile is a plain object; every field is optional. Missing fields
// degrade gracefully (neutral scores, lower profileConfidence) instead of
// throwing.

export const PROFILE_FIELDS = [
  'targetRoles', 'currentRoles', 'seniority', 'skills', 'technologies',
  'domains', 'industries', 'functionalAreas', 'leadershipSignals',
  'yearsExperience', 'locationPrefs', 'workplacePrefs', 'employmentPrefs',
  'compensationPrefs', 'exclusions', 'searchTerms', 'semanticSignals',
  'profileConfidence',
];

const strList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);

/** Parse "$70K" / "$80K-120K" / "80000" → 70000 / 80000 / 80000. First number wins. */
export function parseCompMin(s) {
  const m = String(s || '').match(/([\d,.]+)\s*([kKmM]?)/);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const mult = m[2].toLowerCase() === 'm' ? 1_000_000 : m[2].toLowerCase() === 'k' ? 1000 : 1;
  return Math.round(n * mult);
}

/**
 * Normalize any input (legacy scorer profile, config profile, fixture)
 * into a full Career Profile. Never throws; unknown fields are dropped.
 * Legacy shape {targetRoles, seniority, compensation:{min}, exclusions}
 * maps forward so existing callers keep working.
 */
export function normalizeCareerProfile(input = {}) {
  const p = input && typeof input === 'object' ? input : {};
  const comp = p.compensationPrefs && typeof p.compensationPrefs === 'object'
    ? p.compensationPrefs
    : p.compensation && typeof p.compensation === 'object' ? p.compensation : {};
  const profile = {
    targetRoles: strList(p.targetRoles),
    currentRoles: strList(p.currentRoles),
    seniority: typeof p.seniority === 'string' ? p.seniority.trim().toLowerCase() : '',
    skills: strList(p.skills),
    technologies: strList(p.technologies),
    domains: strList(p.domains),
    industries: strList(p.industries),
    functionalAreas: strList(p.functionalAreas),
    leadershipSignals: strList(p.leadershipSignals),
    yearsExperience: Number.isFinite(Number(p.yearsExperience)) && Number(p.yearsExperience) >= 0
      ? Number(p.yearsExperience) : null,
    locationPrefs: p.locationPrefs && typeof p.locationPrefs === 'object' ? p.locationPrefs : {},
    workplacePrefs: strList(p.workplacePrefs),
    employmentPrefs: strList(p.employmentPrefs),
    compensationPrefs: {
      min: Number.isFinite(Number(comp.min)) ? Number(comp.min) : 0,
      max: Number.isFinite(Number(comp.max)) ? Number(comp.max) : 0,
      currency: typeof comp.currency === 'string' ? comp.currency.trim().toUpperCase() : '',
    },
    exclusions: strList(p.exclusions).map((s) => s.toLowerCase()),
    searchTerms: strList(p.searchTerms),
    semanticSignals: strList(p.semanticSignals),
    profileConfidence: 0,
  };
  profile.profileConfidence = computeProfileConfidence(profile);
  return profile;
}

/** Completeness 0..1 over the fields that drive matching quality. */
export function computeProfileConfidence(profile) {
  const checks = [
    profile.targetRoles.length > 0,
    profile.seniority !== '',
    profile.skills.length + profile.technologies.length > 0,
    profile.functionalAreas.length + profile.domains.length > 0,
    profile.yearsExperience != null,
    profile.compensationPrefs.min > 0,
    Object.keys(profile.locationPrefs).length > 0 || profile.workplacePrefs.length > 0,
  ];
  const hit = checks.filter(Boolean).length;
  return Math.round((hit / checks.length) * 100) / 100;
}

/**
 * Build a Career Profile from a parsed config/profile.yml object.
 * Maps the existing user-layer schema (target_roles, narrative,
 * compensation, location) without requiring new fields; optional
 * `skills:`, `technologies:`, `functional_areas:` etc. pass through
 * when the user adds them.
 */
export function fromConfigProfile(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const archetypes = Array.isArray(r?.target_roles?.archetypes) ? r.target_roles.archetypes : [];
  const levels = archetypes.map((a) => String(a?.level || '').toLowerCase());
  let seniority = '';
  if (levels.some((l) => /director|head|vp|executive|principal/.test(l))) seniority = 'director';
  else if (levels.some((l) => /staff|lead/.test(l))) seniority = 'staff';
  else if (levels.some((l) => /senior/.test(l))) seniority = 'senior';
  else if (levels.some((l) => /mid/.test(l))) seniority = 'mid';
  else if (levels.some((l) => /junior|entry/.test(l))) seniority = 'junior';
  const comp = r?.compensation || {};
  const minNum = parseCompMin(String(comp.minimum ?? comp.target_range ?? ''));
  return normalizeCareerProfile({
    targetRoles: r?.target_roles?.primary,
    seniority,
    skills: [...strList(r?.skills), ...strList(r?.narrative?.superpowers)],
    technologies: r?.technologies,
    domains: r?.domains,
    industries: r?.industries,
    functionalAreas: r?.functional_areas,
    leadershipSignals: ['team leadership', 'people management', 'mentoring', 'strategy', 'roadmap', 'stakeholder'],
    locationPrefs: r?.location,
    workplacePrefs: comp.location_flexibility ? [comp.location_flexibility] : [],
    compensationPrefs: { min: Number.isFinite(minNum) && minNum > 0 ? minNum : 0, currency: comp.currency },
    exclusions: r?.exclusions,
    searchTerms: r?.search_terms,
  });
}

/**
 * Generic resume-text → profile-signal extraction (domain-neutral).
 * Reads explicit Skills/Technologies sections (comma/newline separated
 * items) and role-title lines; never invents terms from a hardcoded
 * vocabulary. Returns partial signals for the user to review and edit —
 * the future upload flow confirms before matching.
 */
export function extractProfileSignals(text) {
  const out = { skills: [], technologies: [], currentRoles: [] };
  if (typeof text !== 'string' || !text.trim()) return out;
  const lines = text.split('\n');
  let section = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const head = line.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (/^(technical |core )?skills$/.test(head)) { section = 'skills'; continue; }
    if (/^(technologies|tech stack|tools)$/.test(head)) { section = 'technologies'; continue; }
    if (/^(experience|employment|work history|education|projects)$/.test(head)) { section = null; continue; }
    if (section && line) {
      for (const item of line.split(/[,•|]/)) {
        const t = item.trim();
        if (t && t.length <= 60 && out[section].length < 60 && !out[section].includes(t)) out[section].push(t);
      }
    }
  }
  return out;
}
