// Explainable opportunity scoring (0-100) — domain-neutral.
//
// Compares a normalized Job against a Career Profile (lib/career-profile.mjs),
// never against hardcoded career categories. The same job scores differently
// for an HR Director and a Senior SWE because the profile differs, not the code.
//
// Every score ships with reasons + penalties citing profile facts — never a
// bare number. Pure function; no I/O, no network.
//
// Bands: 95+ exceptional | 85-94 strong | 75-84 worth reviewing |
// 60-74 weak/secondary | <60 normally reject.

import { normalizeCareerProfile, SENIORITY_LEVELS } from './career-profile.mjs';

const DEFAULT_WEIGHTS = {
  title: 25,        // title fit vs target/current roles
  seniority: 12,    // seniority fit vs profile seniority
  skills: 18,       // skills + technologies hits in title/desc
  functional: 10,   // functional areas + domains + industries hits
  experience: 5,    // years-of-experience vs title scope
  company: 6,       // employer identification + evidence
  compensation: 7,  // pay vs compensation prefs
  location: 10,     // location/workplace fit
  employment: 4,    // employment-type fit
  leadership: 3,    // leadership-signal fit
};

export const MATCH_BANDS = [
  { min: 95, label: 'exceptional', advice: 'Exceptional match' },
  { min: 85, label: 'strong', advice: 'Strong match' },
  { min: 75, label: 'review', advice: 'Worth reviewing' },
  { min: 60, label: 'weak', advice: 'Weak / secondary' },
  { min: 0, label: 'reject', advice: 'Normally reject' },
];

export function scoreToBand(score) {
  return MATCH_BANDS.find((b) => score >= b.min) || MATCH_BANDS[MATCH_BANDS.length - 1];
}

function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length > 1);
}

/** Best-matching target phrase wins, with partial token credit. */
function overlapScore(hayTokens, phrases) {
  if (!phrases.length) return { score: 0, best: '' };
  const hay = new Set(hayTokens);
  let best = 0;
  let bestPhrase = '';
  for (const phrase of phrases) {
    const frac = termFraction(tokens(phrase), hay);
    if (frac > best) { best = frac; bestPhrase = phrase; }
  }
  return { score: best, best: bestPhrase };
}

/**
 * Fraction of a multi-word term's tokens present in the haystack.
 * Single-token terms need the exact token; multi-word terms match at
 * half or more ("LLM systems" fires on "LLM platform", "AI platform
 * architecture" on "AI … architecture"). Domain-neutral: the terms come
 * from the profile, the rule is generic token overlap.
 */
function termFraction(termTokens, haySet) {
  if (!termTokens.length) return 0;
  if (termTokens.length === 1) return haySet.has(termTokens[0]) ? 1 : 0;
  const hit = termTokens.filter((t) => haySet.has(t)).length;
  return hit / termTokens.length >= 0.5 ? hit / termTokens.length : 0;
}

/** Terms from a profile list hitting the job text (token-fraction rule). */
export function termHits(terms, haySet) {
  return (terms || []).filter((s) => s && termFraction(tokens(String(s).toLowerCase()), haySet) > 0);
}

function seniorityOf(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(intern|internship|apprentice|trainee)\b/.test(t)) return 'intern';
  if (/\b(entry[-\s]?level|graduate)\b/.test(t)) return 'entry';
  if (/\bjunior\b/.test(t) && !/\bjunior\s+(achievement|league)\b/.test(t)) return 'junior';
  if (/\bprincipal\b/.test(t)) return 'principal';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'senior';
  if (/\b(head|vp|vice president)\b/.test(t)) return /\bvp\b|vice president/.test(t) ? 'vp' : 'head';
  if (/\bdirector\b/.test(t)) return 'director';
  if (/\b(lead|manager)\b/.test(t)) return /\blead\b/.test(t) ? 'lead' : 'manager';
  return 'mid';
}

const SENIOR_COUNTER = /\b(senior|staff|principal|lead|manager|director|head|vp|vice president|chief)\b/i;

// "Associate" is entry-level ("Associate Engineer") EXCEPT in
// "Associate Director / VP / Dean / Partner / Counsel" — never veto those.
const ASSOCIATE_SENIOR_RE = /\bassociate\s+(director|vp|vice president|dean|partner|counsel|general manager)\b/i;
const JUNIOR_MARKERS = [/\bintern(ship|s)?\b/i, /\bapprentice\b/i, /\btrainee\b/i, /\bentry[-\s]?level\b/i, /\bgraduate\b(?!.*\bprogram\b.*(senior|lead))?/i, /\bjunior\b/i];

function juniorVeto(title, profileRank) {
  if (profileRank < SENIORITY_LEVELS.indexOf('mid')) return null;
  if (SENIOR_COUNTER.test(title)) return null; // senior scope wins over junior words
  for (const re of JUNIOR_MARKERS) {
    const m = title.match(re);
    if (m) return m[0].toLowerCase();
  }
  if (/\bassociate\b/i.test(title) && !ASSOCIATE_SENIOR_RE.test(title)) return 'associate';
  return null;
}

function employmentOf(job, title, desc) {
  let emp = String(job?.employmentType || '').toLowerCase();
  if (!emp) {
    const t = `${title} ${desc}`.toLowerCase();
    if (/\b(contract|contractor|freelance|c2h)\b/.test(t)) emp = 'contract';
    else if (/\bpart[-\s]?time\b/.test(t)) emp = 'part-time';
    else if (/\b(intern|internship)\b/.test(t)) emp = 'internship';
    else if (/\bfull[-\s]?time\b/.test(t)) emp = 'full-time';
  }
  return emp;
}

/**
 * @param {object} job - normalized job (lib/job-model.mjs shape or raw provider job)
 * @param {object} [profile] - Career Profile (or legacy {targetRoles, seniority, compensation, exclusions})
 * @param {object} [weights] - overrides for DEFAULT_WEIGHTS
 * @returns {{score: number, band: object, reasons: string[], penalties: string[], breakdown: object}}
 */
export function scoreJob(job, profile = {}, weights = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const p = normalizeCareerProfile(profile);
  const reasons = [];
  const penalties = [];
  const breakdown = {};
  const title = String(job?.title || '');
  const desc = String(job?.description || '');
  const titleHay = tokens(title);
  const fullHay = tokens(`${title} ${desc}`);
  const text = `${title} ${desc}`.toLowerCase();
  const rolePhrases = [...p.targetRoles, ...p.currentRoles];

  // ---- Negative signals (context-aware vetoes, cap 20) ----
  let vetoed = false;
  for (const ex of p.exclusions) {
    if (ex && title.toLowerCase().includes(ex)) {
      vetoed = true;
      penalties.push(`Exclusion hit: "${ex}"`);
    }
  }
  const profileRank = SENIORITY_LEVELS.indexOf(p.seniority);
  const juniorHit = juniorVeto(title, profileRank);
  if (juniorHit) {
    vetoed = true;
    penalties.push(`Junior marker "${juniorHit}" vs ${p.seniority || 'experienced'}-level profile`);
  }

  // ---- Title fit ----
  const { score: titleFit, best: bestRole } = overlapScore(titleHay, rolePhrases.length ? rolePhrases : [title]);
  breakdown.title = Math.round(titleFit * w.title);
  if (titleFit >= 0.6) reasons.push(`Strong title match${bestRole ? `: "${bestRole}"` : ''}`);
  else if (titleFit <= 0.2) penalties.push('Weak title match to target roles');

  // ---- Seniority fit (symmetric: over- and under-level both cost) ----
  const wantIdx = profileRank >= 0 ? profileRank : SENIORITY_LEVELS.indexOf('senior');
  const gotIdx = SENIORITY_LEVELS.indexOf(seniorityOf(title));
  breakdown.seniority = Math.round(Math.max(0, w.seniority - Math.abs(gotIdx - wantIdx) * 3));
  if (gotIdx === wantIdx) reasons.push(`${seniorityOf(title)}-level scope matches profile`);
  else if (gotIdx > wantIdx) reasons.push(`${seniorityOf(title)}-level scope (stretch above profile)`);
  else penalties.push(`Below profile seniority (${seniorityOf(title)} vs ${p.seniority || 'senior'})`);

  // ---- Skills + technologies (from the PROFILE, not a hardcoded list) ----
  const skillTerms = [...p.skills, ...p.technologies];
  const skillHits = termHits(skillTerms, new Set(fullHay));
  breakdown.skills = skillTerms.length === 0
    ? Math.round(w.skills * 0.5) // no profile signals: neutral, never punishing
    : Math.round(Math.min(1, skillHits.length / 3) * w.skills);
  if (skillHits.length) reasons.push(`Skill match: ${skillHits.slice(0, 3).join(', ')}`);
  else if (skillTerms.length) penalties.push('No profile skill/technology mentioned');

  // ---- Functional / domain / industry fit ----
  const funcTerms = [...p.functionalAreas, ...p.domains, ...p.industries];
  const funcHits = termHits(funcTerms, new Set(fullHay));
  breakdown.functional = funcTerms.length === 0
    ? Math.round(w.functional * 0.5)
    : Math.round(Math.min(1, funcHits.length / 2) * w.functional);
  if (funcHits.length) reasons.push(`Domain match: ${funcHits.slice(0, 2).join(', ')}`);

  // ---- Experience fit ----
  breakdown.experience = w.experience;
  if (p.yearsExperience != null) {
    if (p.yearsExperience >= 8 && ['intern', 'entry', 'junior'].includes(seniorityOf(title))) {
      breakdown.experience = 1;
      penalties.push(`${p.yearsExperience} years experience vs junior-scoped title`);
    } else if (p.yearsExperience <= 2 && ['director', 'head', 'vp', 'executive'].includes(seniorityOf(title))) {
      breakdown.experience = 1;
      penalties.push(`${p.yearsExperience} years experience vs executive-scoped title`);
    } else {
      reasons.push(`${p.yearsExperience} years experience fits scope`);
    }
  }

  // ---- Company evidence ----
  let companyScore = Math.round(w.company * 0.5);
  if (job?.company) { companyScore += 2; reasons.push(`Identified employer: ${job.company}`); }
  else penalties.push('Unknown employer');
  if (job?.sourceCompanyUrl) { companyScore += 1; reasons.push('Company career site found'); }
  if (Array.isArray(job?.sources) && job.sources.length > 1) { companyScore += 1; reasons.push(`Listed on ${job.sources.length} sources`); }
  breakdown.company = Math.min(w.company, companyScore);

  // ---- Compensation ----
  breakdown.compensation = Math.round(w.compensation * 0.6);
  const jobMin = job?.salary?.min ?? null;
  const wantMin = Number(p.compensationPrefs.min) || 0;
  if (jobMin != null && wantMin > 0) {
    if (jobMin >= wantMin) { breakdown.compensation = w.compensation; reasons.push('Compensation meets target'); }
    else { breakdown.compensation = 1; penalties.push('Below compensation target'); }
  }

  // ---- Location / workplace ----
  const loc = `${job?.location || ''}`.toLowerCase();
  const country = String(job?.country || '').toUpperCase();
  const wantsRemote = p.workplacePrefs.some((x) => /remote/i.test(x));
  breakdown.location = Math.round(w.location * 0.4);
  if (country === 'US' && /\bremote\b/.test(loc)) {
    breakdown.location = w.location;
    reasons.push('US remote');
  } else if (country === 'US') {
    breakdown.location = w.location - 3;
    reasons.push('US-based');
  } else if (/\bremote\b/.test(loc)) {
    penalties.push('Remote without US confirmation');
  } else penalties.push('Location unconfirmed');
  if (wantsRemote && /\bremote\b/.test(loc) && country === 'US') reasons.push('Matches remote preference');

  // ---- Employment type vs prefs ----
  const emp = employmentOf(job, title, desc);
  const empPrefs = p.employmentPrefs.map((s) => s.toLowerCase());
  breakdown.employment = Math.round(w.employment * 0.5);
  if (!emp) { breakdown.employment = Math.round(w.employment * 0.6); }
  else if (emp === 'full-time' && (empPrefs.length === 0 || empPrefs.some((x) => /full/.test(x)))) {
    breakdown.employment = w.employment;
    reasons.push('Full-time role');
  } else if (empPrefs.length && empPrefs.some((x) => emp.includes(x.replace(/[^a-z]/g, '')) || x.includes(emp.replace(/[^a-z]/g, '')))) {
    breakdown.employment = w.employment;
    reasons.push(`Matches employment preference (${emp})`);
  } else if (emp === 'contract' || emp === 'part-time' || emp === 'internship') {
    breakdown.employment = 1;
    penalties.push(`${emp} position vs ${empPrefs.join('/') || 'full-time'} preference`);
  }

  // ---- Leadership signals ----
  breakdown.leadership = 1;
  const leadHits = termHits(p.leadershipSignals, new Set(fullHay));
  if (leadHits.length && gotIdx >= SENIORITY_LEVELS.indexOf('senior')) {
    breakdown.leadership = w.leadership;
    reasons.push(`Leadership match: ${leadHits.slice(0, 2).join(', ')}`);
  }

  let score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  if (vetoed) {
    score = Math.min(score, 20);
    penalties.push('Capped: exclusion veto');
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, band: scoreToBand(score), reasons, penalties, breakdown };
}

export { DEFAULT_WEIGHTS, seniorityOf };
