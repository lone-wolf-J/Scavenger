// Company identity normalization for employer discovery and dedup.
//
// Used by the US job-board discovery pipeline (lib/employer-discovery.mjs)
// and cross-board job dedup (lib/job-dedup.mjs). Pure functions, no I/O.
//
// Design: one canonical key per employer so "Acme Inc.", "ACME, Inc" and
// "acme" resolve identically and never create duplicate companies.

const LEGAL_SUFFIXES = [
  'incorporated',
  'corporation',
  'technologies',
  'technology',
  'solutions',
  'services',
  'systems',
  'labs',
  'studio',
  'ventures',
  'capital',
  'partners',
  'group',
  'holdings',
  'company',
  'limited',
  'inc',
  'corp',
  'llc',
  'ltd',
  'co',
  'plc',
  'gmbh',
  'pty',
  'bv',
  'sas',
  'sa',
  'ab',
];

// 'co' / 'sa' are only suffixes with a preceding dot ("Acme Co.", "Acme S.A.").
// Without the dot they are ordinary words ("co" in "Coty", "sa" as a word).
const DOT_SUFFIXES = new Set(['co', 'sa']);

// technology vs technologies (and a few other singular/plural pairs) are the
// same company far more often than they are two different companies.
const STEM_ALIASES = new Map([
  ['technologies', 'technology'],
  ['solutions', 'solution'],
  ['services', 'service'],
  ['systems', 'system'],
  ['labs', 'lab'],
  ['ventures', 'venture'],
  ['partners', 'partner'],
  ['holdings', 'holding'],
]);

// Obvious abbreviations expanded before keying so "IBM" and
// "International Business Machines" share a key.
const ABBREVIATIONS = new Map([
  ['ibm', 'international business machines'],
  ['hp', 'hewlett packard'],
  ['hpe', 'hewlett packard enterprise'],
  ['jpmc', 'jpmorgan chase'],
  ['jpmorgan', 'jpmorgan chase'],
  ['bny', 'bny mellon'],
  ['amzn', 'amazon'],
  ['msft', 'microsoft'],
  ['goog', 'google'],
]);

function stripLegalSuffix(words) {
  let end = words.length;
  // Strip at most two trailing legal tokens ("Acme Inc." / "Acme Group LLC").
  for (let n = 0; n < 2 && end > 1; n++) {
    const last = words[end - 1];
    if (!LEGAL_SUFFIXES.includes(last)) break;
    if (DOT_SUFFIXES.has(last)) break; // dot form handled on the raw string
    end--;
  }
  return words.slice(0, end);
}

/**
 * Canonical identity key for a company name. Empty string when there is no
 * usable signal (never treat as "equal" to another empty key).
 */
export function normalizeCompanyIdentity(name) {
  if (typeof name !== 'string') return '';
  let s = name.normalize('NFKC').toLowerCase();
  // "AT&T" -> "at and t" so the & and the letters survive the strip below.
  s = s.replace(/&/g, ' and ');
  // Handle dot-suffixes on the raw string: "acme co." / "acme s.a.".
  s = s.replace(/\bco\.\s*$/, '').replace(/\bs\.?\s*a\.?\s*$/, '');
  // Parenthetical qualifiers are DBA noise: "Acme (formerly X)".
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  let words = s.split(' ');
  words = stripLegalSuffix(words);
  words = words.map((w) => STEM_ALIASES.get(w) || w);
  s = words.join(' ');
  return ABBREVIATIONS.get(s) || s;
}

// A job board is never the employer. Board names plus their common
// "<board> employer / jobs" placeholder variants.
const BOARD_NAMES = [
  'dice',
  'linkedin',
  'indeed',
  'ziprecruiter',
  'careerbuilder',
  'monster',
  'benchinfo',
  'techfetch',
  'solidjobs',
  'glassdoor',
  'simplyhired',
];

const BOARD_PLACEHOLDERS = new Set();
for (const b of BOARD_NAMES) {
  BOARD_PLACEHOLDERS.add(b);
  BOARD_PLACEHOLDERS.add(`${b} employer`);
  BOARD_PLACEHOLDERS.add(`${b} jobs`);
  BOARD_PLACEHOLDERS.add(`${b} job`);
}

/** True when the "company" is really the job board itself. */
export function isBoardAsEmployer(name) {
  const key = normalizeCompanyIdentity(name);
  if (!key) return true; // no signal -> not a real employer either
  if (BOARD_PLACEHOLDERS.has(key)) return true;
  return /^(dice|linkedin|indeed|monster|ziprecruiter|careerbuilder)(\s+(jobs?|employer))?$/.test(key);
}

// Staffing / intermediary signals. A match means the posting belongs to the
// intermediary unless the role genuinely is staffing-internal (handled by the
// discovery scorer, which weighs it against other evidence).
const STAFFING_PATTERNS = [
  /staffing/i,
  /recruiting(?!.*\b(internal|in-house)\b)/i,
  /\bstaff(ing)?\s+(aug|solutions|firm|agency)\b/i,
  /\btalent\s+(solutions|group|acquisition firm)\b/i,
  /\bconsulting\s+(firm|group|services)\b/i,
  /\bcontract\s+staffing\b/i,
  /\bemployment\s+agency\b/i,
  /\bheadhunter\b/i,
  /\bjob\s+(consultancy|placement)\b/i,
  // Large known US staffing firms operating as intermediaries.
  /\b(tek(partners|systems)|randstad|adecco|manpower|hays|kelly\s+services|insight\s+global|modis|apex\s+systems|kforce|robert\s+half|aerotek|actalent|aston\s+carter|motion\s+recruitment|diverse\s+lynx|collabera|artech|syntel|ustech)\b/i,
];

/** True when the name looks like a staffing intermediary. */
export function isStaffingIntermediary(name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  return STAFFING_PATTERNS.some((re) => re.test(name));
}

// Generic placeholders that carry no employer identity.
const GENERIC_NAMES = new Set([
  'unknown',
  'confidential',
  'confidential company',
  'stealth',
  'stealth startup',
  'stealth mode startup',
  'staffing agency',
  'multiple companies',
  'private employer',
  'undisclosed',
]);

/** True when the name is a placeholder with no real employer behind it. */
export function isGenericEmployerName(name) {
  const key = normalizeCompanyIdentity(name);
  return !key || GENERIC_NAMES.has(key);
}
