// Company input parsing + matching helpers for Target Companies.
// Pure (no node imports) so the web client can share parseCompanyInput.

const CORPORATE_SUFFIX_RE =
  /\b(corporation|incorporated|incorporation|limited|holdings|brands|technologies|technology|systems|solutions|group|company|partners|enterprises|labs|inc|llc|ltd|co|corp|plc|gmbh|sas|bv)\b/gi;

const LEADING_VERB_RE =
  /^(?:please\s+)?(?:find|search|look\s+for|show\s+me|get|list|fetch|pull|check)(?:\s+(?:all|any|the|some|open|current|latest|new))?(?:\s+(?:jobs?|roles?|openings?|positions?|vacancies|postings?|opportunities|careers?))?(?:\s+(?:at|for|from|in|inside|within|across|of|@))?\s+/i;

const TRAILING_NOUN_RE =
  /\s+(?:jobs?|roles?|openings?|positions?|vacancies|postings?|opportunities|careers?|career\s+page|career\s+site|hiring|website|site)$/i;

/** Split free text into company names: commas, semicolons, pipes, newlines. */
export function splitCompanyNames(text) {
  const raw = String(text || '');
  // No structural separators? A lone "X and Y" / "X & Y" / "X plus Y" is a
  // two-company list ("Qualcomm and Deckers"). Multi-word names containing
  // "and" ("Procter and Gamble") are the known casualty — comma-separate
  // those, and the per-company chips make a mis-split visible.
  const parts = /[,;|\r\n]/.test(raw)
    ? raw.split(/[\r\n,;|]+/)
    : raw.split(/\s+(?:and|plus|&)\s+/i);
  return parts
    .map((s) => s.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim())
    .map((s) => s.replace(/^(?:[-*•\d]+\s*[.)]\s*)+/, '').trim())
    .filter(Boolean);
}

/** Strip chatty wrappers: "find jobs at Qualcomm" -> "Qualcomm". */
export function stripChattyWrapping(name) {
  let s = String(name || '').trim();
  s = s.replace(LEADING_VERB_RE, '').trim();
  s = s.replace(TRAILING_NOUN_RE, '').trim();
  return s.replace(/^["'“”‘’@]+|["'“”‘’]+$/g, '').trim();
}

/**
 * Parse chat-friendly input into a deduped company list (max 10).
 * @returns {{companies: string[], dropped: string[], capped: boolean}}
 */
export function parseCompanyInput(text, maxCompanies = 10) {
  const seen = new Set();
  const companies = [];
  const dropped = [];
  for (const raw of splitCompanyNames(text)) {
    const name = stripChattyWrapping(raw);
    if (!name || name.length < 2) {
      if (raw) dropped.push(raw);
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (companies.length >= maxCompanies) {
      dropped.push(name);
      continue;
    }
    companies.push(name);
  }
  return { companies, dropped, capped: dropped.length > 0 };
}

/** Derive DNS slug candidates from a company name ("Deckers Corporation" -> ["deckers"]). */
export function slugVariantsFor(name) {
  const clean = String(name || '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(CORPORATE_SUFFIX_RE, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 2);
  const out = [];
  const push = (s) => {
    if (s && s.length >= 2 && !out.includes(s)) out.push(s);
  };
  if (clean.length >= 1) push(clean.join(''));
  if (clean.length >= 1) push(clean[0]);
  if (clean.length >= 2) push(clean.slice(0, 2).join(''));
  return out.slice(0, 3);
}

/** Normalize a company string for comparison (suffix-stripped, alnum only). */
export function normalizeCompanyKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(CORPORATE_SUFFIX_RE, ' ')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Does a job's company field refer to the target company? Fuzzy both-ways
 * inclusion so "Qualcomm" matches "Qualcomm Incorporated" and vice versa.
 */
export function companyNameMatches(jobCompany, targetCompany) {
  const a = normalizeCompanyKey(jobCompany);
  const b = normalizeCompanyKey(targetCompany);
  if (!a || !b || a.length < 3 || b.length < 3) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  return long.includes(short);
}
