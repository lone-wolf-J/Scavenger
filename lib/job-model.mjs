// Normalized Job model: every provider returns this shape.
//
// Providers still return the minimal legacy shape
// ({title, url, company, location, ...}) — normalizeJob() enriches it into
// the full model so the scanner, discovery, matching and dedup layers all
// read the same fields regardless of source (HTML / API / MCP / ATS).
//
// Provider-specific detail is preserved verbatim in rawProviderData.

/**
 * @typedef {object} NormalizedJob
 * @property {string} id - stable dedup id: `${source}:${sourceJobId || url}`
 * @property {string} title
 * @property {string} company - employer as reported by the source
 * @property {string} location - raw location string
 * @property {string} country - 'US' / '' (unknown) — best-effort parse
 * @property {string} state - US postal code or '' (best-effort parse)
 * @property {string} city - best-effort parse
 * @property {string} workplaceType - 'remote'|'hybrid'|'on-site'|''
 * @property {string} employmentType - 'full-time'|'contract'|'part-time'|''
 * @property {{min:number,max:number,currency:string,raw:string}|null} salary
 * @property {string} description
 * @property {number|undefined} postedAt - epoch ms
 * @property {number} discoveredAt - epoch ms (normalization time)
 * @property {string} url - canonical posting URL
 * @property {string} applyUrl - apply URL (defaults to url)
 * @property {string} source - provider id (dice, linkedin, greenhouse, ...)
 * @property {string} sourceJobId - provider-native id when extractable
 * @property {string} sourceCompanyUrl
 * @property {string} recruiterOrEmployerType - 'employer'|'recruiter'|'unknown'
 * @property {string} sponsorship - raw sponsorship wording or ''
 * @property {object} rawProviderData - untouched provider extras
 */

const US_STATE_BY_NAME = new Map([
  ['alabama', 'AL'], ['alaska', 'AK'], ['arizona', 'AZ'], ['arkansas', 'AR'],
  ['california', 'CA'], ['colorado', 'CO'], ['connecticut', 'CT'], ['delaware', 'DE'],
  ['florida', 'FL'], ['georgia', 'GA'], ['hawaii', 'HI'], ['idaho', 'ID'],
  ['illinois', 'IL'], ['indiana', 'IN'], ['iowa', 'IA'], ['kansas', 'KS'],
  ['kentucky', 'KY'], ['louisiana', 'LA'], ['maine', 'ME'], ['maryland', 'MD'],
  ['massachusetts', 'MA'], ['michigan', 'MI'], ['minnesota', 'MN'], ['mississippi', 'MS'],
  ['missouri', 'MO'], ['montana', 'MT'], ['nebraska', 'NE'], ['nevada', 'NV'],
  ['new hampshire', 'NH'], ['new jersey', 'NJ'], ['new mexico', 'NM'], ['new york', 'NY'],
  ['north carolina', 'NC'], ['north dakota', 'ND'], ['ohio', 'OH'], ['oklahoma', 'OK'],
  ['oregon', 'OR'], ['pennsylvania', 'PA'], ['rhode island', 'RI'], ['south carolina', 'SC'],
  ['south dakota', 'SD'], ['tennessee', 'TN'], ['texas', 'TX'], ['utah', 'UT'],
  ['vermont', 'VT'], ['virginia', 'VA'], ['washington', 'WA'], ['west virginia', 'WV'],
  ['wisconsin', 'WI'], ['wyoming', 'WY'], ['district of columbia', 'DC'],
]);

function parseCityState(location) {
  const out = { city: '', state: '', country: '' };
  if (typeof location !== 'string' || !location.trim()) return out;
  const loc = location.trim();
  if (/\bunited states\b/i.test(loc) || /\bUSA?\b/.test(loc)) out.country = 'US';
  const m = loc.match(/,\s*([A-Za-z ]+?)\s*$/);
  if (m) {
    const tail = m[1].trim();
    if (/^[A-Z]{2}$/.test(tail)) {
      out.state = tail.toUpperCase();
      out.city = loc.slice(0, m.index).split(/[,|]/).pop().trim();
    } else if (US_STATE_BY_NAME.has(tail.toLowerCase())) {
      out.state = US_STATE_BY_NAME.get(tail.toLowerCase());
      out.city = loc.slice(0, m.index).split(/[,|]/).pop().trim();
    }
  }
  if (out.state) out.country = out.country || 'US';
  return out;
}

function parseWorkplaceType(location, title = '') {
  const text = `${location || ''} ${title || ''}`.toLowerCase();
  if (/\bhybrid\b/.test(text)) return 'hybrid';
  if (/\bon[-\s]?site\b/.test(text) || /\bin[-\s]?office\b/.test(text)) return 'on-site';
  if (/\bremote\b/.test(text)) return 'remote';
  return '';
}

function parseEmploymentType(text = '') {
  const t = String(text).toLowerCase();
  if (/\b(contract|contractor|contract-to-hire|c2h|freelance|temp\b)/.test(t)) return 'contract';
  if (/\bpart[-\s]?time\b/.test(t)) return 'part-time';
  if (/\b(intern|internship)\b/.test(t)) return 'internship';
  if (/\bfull[-\s]?time\b/.test(t)) return 'full-time';
  return '';
}

function extractSourceJobId(url, source) {
  if (typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    // LinkedIn guest links: /jobs/view/<id>
    const li = u.pathname.match(/\/jobs\/view\/(\d+)/);
    if (li) return li[1];
    for (const key of ['jobId', 'job_id', 'id', 'jobid', 'postingId', 'gh_jid', 'job']) {
      const v = u.searchParams.get(key);
      if (v) return v;
    }
    const tail = u.pathname.split('/').filter(Boolean).pop() || '';
    if (/^[A-Za-z0-9_-]{4,64}$/.test(tail) && !/^(jobs|job|search|view|careers)$/i.test(tail)) return tail;
  } catch { /* ignore */ }
  return '';
}

/**
 * Normalize through a provider's own hook when it supplies one
 * (`provider.normalize(raw, source)`), otherwise the shared normalizeJob().
 * The scanner never cares whether data came from HTML, API, ATS, or MCP —
 * every path converges here on the same NormalizedJob.
 */
export function normalizeProviderJob(provider, raw, source = 'unknown', now = Date.now()) {
  if (provider && typeof provider.normalize === 'function') {
    try {
      const out = provider.normalize(raw, source);
      if (out && typeof out === 'object' && out.title && out.url) {
        return normalizeJob({ ...out, source: out.source || source }, out.source || source, now);
      }
    } catch {
      // a broken hook must never lose the job — fall through to default
    }
  }
  return normalizeJob(raw, source, now);
}

/**
 * Provenance for one normalized job / accepted offer. Answers: where did
 * this come from, what is the original URL, what is the canonical
 * opportunity, which providers reported it, what employer evidence exists.
 */
export function jobProvenance(job) {
  return {
    originUrl: job?.url || '',
    applyUrl: job?.applyUrl || job?.url || '',
    source: job?.source || '',
    sources: Array.isArray(job?.sources) ? [...job.sources] : job?.source ? [job.source] : [],
    sourceJobId: job?.sourceJobId || '',
    canonicalKey: '',
    employer: job?.company || '',
    employerEvidence: job?.matchReasons || [],
    discoveredAt: job?.discoveredAt || null,
    postedAt: typeof job?.postedAt === 'number' ? job.postedAt : null,
  };
}
/**
 * Normalize a raw provider job into the common model. Never throws for
 * object input; unknown fields land in rawProviderData.
 */
export function normalizeJob(raw, source = 'unknown', now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const title = String(r.title || '').trim();
  const url = String(r.url || r.applyUrl || '').trim();
  const company = String(r.company || '').trim();
  const location = String(r.location || '').trim();
  const description = String(r.description || '').trim();
  const geo = parseCityState(location);
  const sourceJobId = String(r.sourceJobId || extractSourceJobId(url, source) || '').trim();
  const salary = r.salary && typeof r.salary === 'object'
    ? { min: r.salary.min ?? null, max: r.salary.max ?? null, currency: r.salary.currency || '', raw: r.salary.raw || r.compensation || '' }
    : (typeof r.compensation === 'string' && r.compensation.trim()
      ? { min: null, max: null, currency: '', raw: r.compensation.trim() }
      : null);
  const known = new Set(['title', 'url', 'applyUrl', 'company', 'location', 'description', 'postedAt', 'compensation', 'salary', 'source', 'sourceJobId', 'sourceCompanyUrl', 'employmentType', 'workplaceType', 'country', 'state', 'city']);
  const rawProviderData = {};
  for (const [k, v] of Object.entries(r)) if (!known.has(k)) rawProviderData[k] = v;
  if (r.rawProviderData && typeof r.rawProviderData === 'object') Object.assign(rawProviderData, r.rawProviderData);

  return {
    id: `${source}:${sourceJobId || url || title}`,
    title,
    company,
    location,
    country: String(r.country || geo.country || ''),
    state: String(r.state || geo.state || ''),
    city: String(r.city || geo.city || ''),
    workplaceType: String(r.workplaceType || parseWorkplaceType(location, title) || ''),
    employmentType: String(r.employmentType || parseEmploymentType(`${title} ${description}`) || ''),
    salary,
    description,
    postedAt: typeof r.postedAt === 'number' && Number.isFinite(r.postedAt) ? r.postedAt : undefined,
    discoveredAt: typeof r.discoveredAt === 'number' ? r.discoveredAt : now,
    url,
    applyUrl: String(r.applyUrl || url || '').trim(),
    source,
    sourceJobId,
    sourceCompanyUrl: String(r.sourceCompanyUrl || ''),
    recruiterOrEmployerType: String(r.recruiterOrEmployerType || ''),
    sponsorship: String(r.sponsorship || ''),
    rawProviderData,
  };
}
