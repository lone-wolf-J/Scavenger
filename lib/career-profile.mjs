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

// Shared seniority ladder (match-score.mjs and resume-signals.mjs import
// from here so target-role inference never creates an import cycle).
export const SENIORITY_LEVELS = ['intern', 'entry', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'head', 'vp', 'executive'];

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

// ---------- signals → Career Profile (Phase 3) ----------

function bumpSeniority(title) {
  // Highest marker wins, with one title-convention exception: "Senior X
  // Manager/Lead" is senior (Senior Manager sits above Manager), while
  // "Senior Staff/Principal/Director" keeps the higher marker.
  const t = String(title || '').toLowerCase();
  const has = (re) => re.test(t);
  const seniorHit = has(/\b(senior|sr\.?)\b/);
  const leadHit = has(/\b(manager|lead)\b/);
  const higherHit = has(/\b(head|vp|vice president|chief|executive|director|principal|staff)\b/);
  if (seniorHit && leadHit && !higherHit) return 'senior';
  const hits = [];
  if (has(/\b(head|vp|vice president|chief|executive)\b/)) hits.push('head');
  if (has(/\bdirector\b/)) hits.push('director');
  if (leadHit) hits.push('lead');
  if (has(/\b(principal|staff)\b/)) hits.push('staff');
  if (seniorHit) hits.push('senior');
  if (has(/\bjunior\b/)) hits.push('junior');
  if (has(/\b(intern|entry)\b/)) hits.push('entry');
  if (!hits.length) return 'mid';
  return hits.sort((a, b) => SENIORITY_LEVELS.indexOf(b) - SENIORITY_LEVELS.indexOf(a))[0];
}

/**
 * Derive plausible target roles from career history. Kinds:
 *   current    — the most recent title (confidence 0.9)
 *   historical — earlier titles, decaying with age (0.7 → 0.5)
 *   inferred   — one step up the seniority ladder from current
 *                (confidence 0.55, ALWAYS requiresConfirmation)
 * Inferred roles are proposals, never desires: the review step confirms.
 */
export function inferTargetRoles(signals) {
  const out = [];
  const current = (signals?.currentRoles || [])[0];
  if (current?.title) {
    out.push({
      role: current.title, kind: 'current', confidence: 0.9,
      requiresConfirmation: false,
      evidence: current.evidence || [],
    });
    // One-step-up inference: swap the seniority marker, keep the craft.
    const idx = SENIORITY_LEVELS.indexOf(bumpSeniority(current.title));
    if (idx >= 0 && idx < SENIORITY_LEVELS.length - 1) {
      const next = SENIORITY_LEVELS[idx + 1];
      const variants = { senior: 'Senior', staff: 'Staff', principal: 'Principal', lead: 'Lead', manager: 'Manager', director: 'Director', head: 'Head of' };
      if (variants[next] && !new RegExp(`\\b${next}\\b`, 'i').test(current.title)) {
        const base = current.title.replace(/\b(senior|sr\.?|staff|principal|lead|junior|mid|entry|associate)\b/gi, '').replace(/\s+/g, ' ').trim();
        if (base) {
          out.push({
            role: `${variants[next]} ${base}`, kind: 'inferred', confidence: 0.55,
            requiresConfirmation: true,
            evidence: [`career trajectory from "${current.title}"`, ...(current.evidence || []).slice(0, 1)],
          });
        }
      }
    }
  }
  (signals?.previousRoles || []).forEach((r, i) => {
    if (!r?.title) return;
    out.push({
      role: r.title, kind: 'historical',
      confidence: Math.round(Math.max(0.5, 0.7 - i * 0.05) * 100) / 100,
      requiresConfirmation: false,
      evidence: r.evidence || [],
    });
  });
  // Deduplicate by case-insensitive role, keeping the highest confidence.
  const seen = new Map();
  for (const t of out) {
    const k = t.role.toLowerCase();
    if (!seen.has(k) || seen.get(k).confidence < t.confidence) seen.set(k, t);
  }
  return [...seen.values()];
}

/**
 * Evidence-weighted profile confidence (0..1): "does Scavenger have enough
 * information to model this profile" — never a judgment of candidate quality.
 */
export function computeSignalConfidence(signals) {
  if (!signals || typeof signals !== 'object') return 0;
  let score = 0;
  const cur = (signals.currentRoles || [])[0];
  if (cur?.title) score += 0.2;
  if (cur?.range) score += 0.05; // dated current role
  const skillCount = (signals.skills || []).length + (signals.technologies || []).length;
  score += Math.min(0.15, skillCount * 0.02);
  if (signals.yearsExperience?.value != null) score += signals.yearsExperience.provenance === 'explicit' ? 0.15 : 0.1;
  if (bumpSeniority(cur?.title || '') !== 'mid' || (signals.leadershipSignals || []).length) score += 0.1;
  if ((signals.locations || []).length) score += 0.1;
  if ((signals.education || []).length || (signals.certifications || []).length) score += 0.1;
  if ((signals.previousRoles || []).length >= 2) score += 0.1; // consistent history
  if (inferTargetRoles(signals).some((t) => t.kind === 'current')) score += 0.1;
  return Math.round(Math.min(1, score) * 100) / 100;
}

/** Convert evidence-first signals into a generic Career Profile. */
export function fromSignals(signals) {
  const s = signals && typeof signals === 'object' ? signals : {};
  const targets = inferTargetRoles(s);
  const cur = (s.currentRoles || [])[0];
  const terms = (arr) => (arr || []).map((x) => (typeof x === 'string' ? x : x?.value || x?.name || x?.line || '')).filter(Boolean);
  const profile = normalizeCareerProfile({
    targetRoles: targets.filter((t) => t.kind !== 'inferred').map((t) => t.role),
    currentRoles: cur?.title ? [cur.title] : [],
    seniority: cur?.title ? bumpSeniority(cur.title) : '',
    skills: terms(s.skills),
    technologies: terms(s.technologies),
    leadershipSignals: (s.leadershipSignals || []).map((l) => l.signal || l.term || '').filter(Boolean),
    yearsExperience: s.yearsExperience?.value,
    locationPrefs: { raw: terms(s.locations) },
    workplacePrefs: terms(s.workplacePrefs),
    employmentPrefs: terms(s.employmentPrefs),
    compensationPrefs: { min: parseCompMin(terms(s.compensationSignals)[0] || '') },
    searchTerms: targets.map((t) => t.role),
  });
  // Evidence-weighted confidence wins over the field-completeness default:
  // it knows explicit vs inferred, which the generic counter cannot see.
  profile.profileConfidence = computeSignalConfidence(s);
  profile.inferredTargets = targets.filter((t) => t.kind === 'inferred');
  return profile;
}
