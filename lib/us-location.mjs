// Strict US-only location classification.
//
// Standalone companion to scan.mjs's `mode: 'us_only'` filter: same rule,
// reusable outside the scan loop (employer discovery, matching engine,
// provider tests) with structured evidence for every verdict.
//
// Accept: US cities/states/abbreviations, USA/United States, US-qualified
// remote ("Remote - US", "Remote in United States", ...).
// Reject: non-US countries, worldwide/global, bare "Remote", "Remote -
// Worldwide", "Remote - North America" without explicit US eligibility.

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
]);

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california',
  'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas',
  'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
  'michigan', 'minnesota', 'mississippi', 'missouri', 'montana',
  'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico',
  'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma',
  'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia',
];

const NON_US_COUNTRIES = [
  'india', 'united kingdom', 'great britain', 'england', 'scotland',
  'wales', 'germany', 'france', 'canada', 'australia', 'new zealand',
  'singapore', 'japan', 'brazil', 'mexico', 'ireland', 'spain', 'italy',
  'netherlands', 'switzerland', 'sweden', 'norway', 'denmark', 'finland',
  'poland', 'portugal', 'belgium', 'austria', 'china', 'hong kong',
  'taiwan', 'south korea', 'philippines', 'malaysia', 'israel',
  'united arab emirates', 'south africa', 'indonesia', 'vietnam',
  'thailand', 'turkey', 'argentina', 'chile', 'colombia', 'egypt',
  'nigeria', 'kenya', 'pakistan', 'bangladesh', 'sri lanka', 'nepal',
  'ukraine', 'romania', 'hungary', 'czech republic', 'greece',
];

// Bare "uk" needs a boundary-aware check done separately (it collides with
// the middle of words); multiword entries above are matched as phrases.
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasUsCountryMarker(text) {
  return /\b(?:united states(?: of america)?|u\.?s\.?a?\.?|usa)\b/i.test(text);
}

function hasUkMarker(text) {
  return /(?<![a-z])uk(?![a-z])/i.test(text);
}

function hasUsState(text) {
  const lower = text.toLowerCase().trim();
  for (const state of US_STATE_NAMES) {
    const re = new RegExp(`(?:^|,\\s*|\\|\\s*|\\b)${escapeRe(state)}(?=$|\\s*,|\\s*\\||\\s*$)`, 'i');
    if (re.test(lower)) return true;
  }
  const stateCodeRe = /(?:^|,\s*|\|\s*|\bremote\s*[-–—,]?\s*)([a-z]{2})(?=$|[\s,|])/gi;
  let match;
  while ((match = stateCodeRe.exec(lower)) !== null) {
    if (US_STATE_CODES.has(match[1].toUpperCase())) return true;
  }
  return false;
}

function nonUsHit(text) {
  const lower = text.toLowerCase();
  for (const country of NON_US_COUNTRIES) {
    if (new RegExp(`(?<![a-z])${escapeRe(country)}(?![a-z])`).test(lower)) return country;
  }
  if (hasUkMarker(lower)) return 'uk';
  return null;
}

// "Remote - United States" / "Remote in Texas" / "US Remote" all carry an
// explicit US qualifier; bare "Remote" and "Remote - Worldwide" do not.
function remoteWithUsQualifier(text) {
  if (!/\bremote\b/i.test(text)) return false;
  const withoutRemote = text.replace(/\bremote\b/gi, ' ');
  return hasUsCountryMarker(withoutRemote) || hasUsState(withoutRemote);
}

/**
 * Classify a free-text location string.
 * @returns {{ verdict: 'us'|'non-us'|'unknown', evidence: string[] }}
 */
export function classifyUsLocation(location, { url = '' } = {}) {
  const evidence = [];
  const raw = typeof location === 'string' ? location.trim() : '';
  // Recover Workday-style "/job/{City-State-Country}/" hints (see scan.mjs).
  let hint = '';
  if (typeof url === 'string' && url.trim()) {
    try {
      const segs = new URL(url).pathname.split('/').filter(Boolean);
      const jobIdx = segs.lastIndexOf('job');
      if (jobIdx !== -1 && jobIdx < segs.length - 1) {
        let segment = segs[jobIdx + 1];
        try { segment = decodeURIComponent(segment); } catch { /* keep raw */ }
        hint = segment.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      }
    } catch { /* unparseable URL -> no hint */ }
  }
  const combined = [raw.toLowerCase(), hint].filter(Boolean).join(' | ');
  if (!combined) return { verdict: 'unknown', evidence: ['no location data'] };

  const foreign = nonUsHit(combined);
  if (foreign) {
    evidence.push(`non-US marker: ${foreign}`);
    return { verdict: 'non-us', evidence };
  }
  if (hasUsCountryMarker(combined)) {
    evidence.push('explicit United States / USA / US marker');
    return { verdict: 'us', evidence };
  }
  if (hasUsState(combined)) {
    evidence.push('US state name or postal abbreviation');
    return { verdict: 'us', evidence };
  }
  if (remoteWithUsQualifier(raw)) {
    evidence.push('remote with explicit US qualifier');
    return { verdict: 'us', evidence };
  }
  if (/\bremote\b/i.test(combined)) {
    evidence.push('remote without US evidence');
    return { verdict: 'non-us', evidence };
  }
  if (/\b(worldwide|global|emea|apac|latam|americas|north america|europe)\b/i.test(combined)) {
    evidence.push('worldwide/global/regional scope without US eligibility');
    return { verdict: 'non-us', evidence };
  }
  return { verdict: 'unknown', evidence: ['no recognizable US or non-US marker'] };
}

/** Boolean gate: only 'us' passes. Unknown is rejected (strict mode). */
export function isUsLocation(location, opts) {
  return classifyUsLocation(location, opts).verdict === 'us';
}
