// Company-targeted crawl for Target Companies — resolve a free-text company
// name to its career site / ATS board, pull every posting, upsert into the
// shared job store, and return canonical keys for profile matching.
//
// Pipeline per company:
//   1. resolveCompany() — ATS slug probes (greenhouse/lever/ashby official
//      APIs) then careers-page candidates (careers.<slug>.com, <slug>.com/
//      careers, …) with every company-scoped provider's detect() routed over
//      the final URL + extracted links. Query-board providers (dice,
//      linkedin, …) are never detect-routed — their detect() claims any
//      entry and they serve keyword search, not company boards.
//   2. Board fetch — runProvider() on the resolved ATS board (all postings,
//      paginated, capped by max_pages).
//   3. Board-keyword supplement — dice/linkedin/wellfound keyword search for
//      "<Company>" + profile role terms, filtered to actual company matches,
//      so companies whose ATS blocks us (Eightfold PCSX, …) still surface.
//   4. Normalize + US-only + freshness, upsert into the shared job store,
//      persist a run record. Matching itself stays in the opportunities
//      service (getOpportunities filtered to the crawled keys) so cards,
//      history flags and intel render identically to the Jobs page.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProviders } from '../providers/_registry.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';
import { runProvider } from './provider-result.mjs';
import { normalizeProviderJob } from './job-model.mjs';
import { classifyUsLocation } from './us-location.mjs';
import { canonicalJobKey } from './job-dedup.mjs';
import { openJobRepository } from './repositories/job-repository.mjs';
import { slugVariantsFor, companyNameMatches } from './company-input.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROVIDERS_DIR = join(HERE, '..', 'providers');

// detect()-routed NEVER: keyword-search boards claim any entry passed with
// their id — they are query providers, not company boards.
const BOARD_PROVIDER_IDS = new Set([
  'dice', 'linkedin', 'indeed', 'careerbuilder', 'monster',
  'ziprecruiter', 'techfetch', 'wellfound', 'remoteok', 'weworkremotely',
  'remotive', 'himalayas', 'themuse', 'remotli', 'hackernews', 'jobicy',
  'landingjobs', 'workingnomads', 'nodesk', 'jobspresso',
]);

// Keyword supplement runs on boards proven reachable + query-honoring.
const SUPPLEMENT_PROVIDERS = ['dice', 'linkedin', 'wellfound'];

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 3_000_000;
const MAX_URLS_TESTED = 40;

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** SSRF guard: https only, DNS names (no IP literals), sane shape. */
export function isSafeHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return true;
}

async function fetchTextCapped(url, fetchFn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await (fetchFn || fetch)(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    return { ok: true, status: res.status, finalUrl: res.url || url, html: text.slice(0, MAX_BODY_BYTES) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

function extractHrefs(html, base) {
  const out = [];
  const seen = new Set();
  const push = (abs) => {
    if (!abs.startsWith('https://') || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < MAX_URLS_TESTED * 3) {
    try {
      push(new URL(m[1], base).toString());
    } catch { /* relative junk */ }
  }
  return out;
}

// Tenant/API hosts embedded in JS bundles (href extractors miss these —
// Eightfold serves tenant links as HTML-entity-escaped JSON strings).
const TENANT_URL_RES = [
  /https:\/\/[a-z0-9-]+\.eightfold\.ai(?:[^\s"'<>\\]|\\.)*/gi,
  /https:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com(?:[^\s"'<>\\]|\\.)*/gi,
  /https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/[a-z0-9-]+/gi,
  /https:\/\/jobs\.ashbyhq\.com\/[a-z0-9-]+/gi,
  /https:\/\/jobs\.lever\.co\/[a-z0-9-]+/gi,
];

function extractTenantUrls(html) {
  const out = [];
  for (const re of TENANT_URL_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) && out.length < 20) {
      // Cut JSON-escaping backslashes, HTML entities (&#34;) and trailing
      // punctuation — tenant URLs hide in script blobs.
      const clean = m[0].split('\\')[0].split(/&#/)[0].replace(/[",;}\])]+$/, '').trim();
      if (isSafeHttpUrl(clean) && !out.includes(clean)) out.push(clean);
    }
  }
  return out;
}

// Signals that a link likely leads to the actual job board (tested first so
// late-body apply links aren't cut by the per-company URL cap).
const BOARD_LINK_RE = /workday|mywork|greenhouse|lever\.co|ashby|eightfold|taleo|icims|successfactors|phenom|avature|brassring|kenexa|smartrecruiters|breezy|bamboohr|jobvite|radancy|pinpoint|teamtailor|boards-api|career|job|apply|board|opening|position|wd\d/i;

function prioritizeUrls(urls) {
  const hot = [];
  const rest = [];
  for (const u of urls) (BOARD_LINK_RE.test(u) ? hot : rest).push(u);
  return [...hot, ...rest];
}

/**
 * Resolve a company name to a crawlable board.
 * @returns {{company, resolved: boolean, providerId?, url?, method?, error?}}
 */
export async function resolveCompany(name, { providers, fetchFn } = {}) {
  const company = String(name || '').trim();
  if (!company) return { company, resolved: false, error: 'empty company name' };
  const mods = providers || (await loadProviders(DEFAULT_PROVIDERS_DIR));
  const slugs = slugVariantsFor(company);

  // 1. Official ATS board APIs by slug probe (cheap, authoritative).
  const slugProbes = [
    { id: 'greenhouse', url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=false`, ok: (j) => Array.isArray(j?.jobs) || Array.isArray(j) },
    { id: 'lever', url: (s) => `https://api.lever.co/v0/postings/${s}?limit=1`, ok: (j) => Array.isArray(j) },
    { id: 'ashby', url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, ok: (j) => Array.isArray(j?.jobs) },
  ];
  for (const slug of slugs) {
    for (const probe of slugProbes) {
      const mod = mods.get(probe.id);
      if (!mod) continue;
      try {
        const res = await (fetchFn || fetch)(probe.url(slug), { headers: { 'user-agent': BROWSER_UA } });
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (probe.ok(data)) {
          const apiUrl = probe.url(slug);
          return { company, resolved: true, providerId: probe.id, url: apiUrl, apiUrl, method: `ats-slug:${probe.id}` };
        }
      } catch { /* next probe */ }
    }
  }

  // 2. Careers-page candidates → detect() routing over final URL + links.
  const candidates = [];
  for (const slug of slugs) {
    candidates.push(
      `https://careers.${slug}.com`,
      `https://jobs.${slug}.com`,
      `https://${slug}.com/careers`,
      `https://www.${slug}.com/careers`,
    );
  }
  for (const start of candidates) {
    if (!isSafeHttpUrl(start)) continue;
    const page = await fetchTextCapped(start, fetchFn);
    if (!page.ok || !page.html) continue;
    // Company domain guess for tenant APIs that need it (Eightfold
    // ?domain=): careers.qualcomm.com -> qualcomm.com.
    let companyDomain = null;
    try {
      companyDomain = new URL(page.finalUrl).hostname.replace(/^(careers|jobs|www)\./, '');
    } catch { /* ignore */ }
    const withDomain = (u) => {
      try {
        if (!companyDomain || !/^[a-z0-9-]+\.eightfold\.ai$/i.test(new URL(u).hostname)) return u;
        const mod = new URL(u);
        if (!mod.searchParams.get('domain')) mod.searchParams.set('domain', companyDomain);
        return mod.toString();
      } catch {
        return u;
      }
    };
    const urls = [
      page.finalUrl,
      ...extractTenantUrls(page.html).map(withDomain),
      ...prioritizeUrls(extractHrefs(page.html, page.finalUrl)),
    ].filter(isSafeHttpUrl).slice(0, MAX_URLS_TESTED);
    for (const url of urls) {
      for (const [id, mod] of mods) {
        if (BOARD_PROVIDER_IDS.has(id) || typeof mod.detect !== 'function') continue;
        // NOTE: no `provider` field on the probe entry — several providers
        // claim any entry carrying their own id (4dayweek, echojobs, …),
        // which would hijack every resolution. URL-pattern detects only.
        let claim = null;
        try {
          claim = mod.detect({ name: company, careers_url: url });
        } catch { /* provider-specific guard — not a claim */ }
        if (claim && (claim.url || url)) {
          return {
            company, resolved: true, providerId: id, url,
            sourceUrl: url, claimUrl: claim.url && claim.url !== url ? claim.url : null,
            method: `careers-page:${id}`,
          };
        }
      }
    }
  }
  return { company, resolved: false, error: 'no ATS board or careers page resolved — try the exact careers URL' };
}

function topRoleTerms(profiles, max = 2) {
  const seen = new Set();
  const out = [];
  for (const p of profiles || []) {
    const roles = p?.profile?.targetRoles || p?.targetRoles || [];
    for (const r of Array.isArray(roles) ? roles : []) {
      const t = String(r || '').trim();
      if (t && !seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        out.push(t);
      }
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Crawl one company: board fetch + keyword supplement, upsert, run record.
 */
export async function crawlCompanyJobs({
  company,
  profiles = [],
  roleTerms,
  maxPages = 25,
  maxAgeDays = 14,
  dataRoot = null,
  jobStorePath = null,
  runsDir = null,
  providersDir,
  providerModules,
  fetchFn,
  now = Date.now(),
} = {}) {
  const t0 = Date.now();
  const runId = uid('cc');
  const startedAt = new Date(now).toISOString();
  const mods = providerModules || (await loadProviders(providersDir || DEFAULT_PROVIDERS_DIR));
  const ctx = { ...makeHttpCtx(), maxPages };
  const cutoff = now - maxAgeDays * 86_400_000;
  const errors = [];
  const accepted = [];
  let fetched = 0;
  let resolution = { company, resolved: false };

  const keep = (raw, providerId) => {
    let job;
    try {
      job = normalizeProviderJob(mods.get(providerId), raw, providerId, now);
    } catch {
      return;
    }
    if (classifyUsLocation(job.location, { url: job.url }).verdict !== 'us') return;
    if (typeof job.postedAt === 'number' && Number.isFinite(job.postedAt) && job.postedAt < cutoff) return;
    accepted.push({ ...job, _providerId: providerId, source: providerId });
  };

  // Board path: source URL first (tenant patterns parse cleanly from career
  // pages); claim URL as fallback (some detects return a normalized API URL
  // the fetch needs, e.g. Eightfold + domain).
  resolution = await resolveCompany(company, { providers: mods, fetchFn });
  if (resolution.resolved) {
    const mod = mods.get(resolution.providerId);
    const candidates = [
      resolution.apiUrl ? { api: resolution.apiUrl } : null,
      resolution.sourceUrl ? { careers_url: resolution.sourceUrl } : null,
      resolution.claimUrl ? { careers_url: resolution.claimUrl } : null,
      resolution.url && resolution.url !== resolution.sourceUrl && resolution.url !== resolution.claimUrl
        ? { careers_url: resolution.url }
        : null,
    ].filter(Boolean);
    let boardOk = false;
    for (const variant of candidates) {
      const entry = { name: company, provider: resolution.providerId, max_pages: maxPages, ...variant };
      const res = await runProvider(mod, entry, ctx);
      if (res.status === 'error') {
        errors.push({ provider: resolution.providerId, errorType: res.errorType, message: `${res.message} [via ${Object.values(variant)[0]?.slice?.(0, 80) || '?'}]` });
        continue;
      }
      if (!res.jobs.length) continue; // empty board — wrong endpoint shape, try next variant
      boardOk = true;
      resolution.url = Object.values(variant)[0];
      fetched += res.jobs.length;
      for (const raw of res.jobs) keep(raw, resolution.providerId);
      break;
    }
    if (!boardOk) resolution.boardFailed = true;
  }

  // Keyword supplement on working boards (also the whole story when the ATS blocks us).
  const terms = Array.isArray(roleTerms) && roleTerms.length ? roleTerms : topRoleTerms(profiles);
  if (terms.length) {
    const query = `"${company}" (${terms.map((t) => `"${t}"`).join(' OR ')})`;
    for (const pid of SUPPLEMENT_PROVIDERS) {
      const mod = mods.get(pid);
      if (!mod) continue;
      const entry = { name: `company-crawl:${company}:${pid}`, provider: pid, query, location: 'United States' };
      const res = await runProvider(mod, entry, ctx);
      if (res.status === 'error') {
        errors.push({ provider: pid, errorType: res.errorType, message: res.message });
        continue;
      }
      fetched += res.jobs.length;
      for (const raw of res.jobs) {
        if (!companyNameMatches(raw.company || raw.companyName || '', company)) continue;
        keep(raw, pid);
      }
    }
  }

  const canonicalKeys = [...new Set(accepted.map((j) => { try { return canonicalJobKey(j); } catch { return ''; } }).filter(Boolean))];
  const canonicalUrls = [...new Set(accepted.map((j) => j.url).filter((u) => typeof u === 'string' && u))];

  let persisted = { added: 0 };
  const storePath = jobStorePath || (dataRoot ? join(dataRoot, 'data', 'scavenger', 'job-store.json') : null);
  if (storePath && accepted.length) {
    try {
      const repo = openJobRepository(storePath);
      const res = repo.upsert(accepted.map((j) => ({ ...j, source: j._providerId })));
      persisted = { added: res?.added ?? 0, updated: res?.updated ?? 0 };
    } catch (e) {
      errors.push({ provider: 'job-store', errorType: 'PERSIST_ERROR', message: String(e?.message || e).slice(0, 200) });
    }
  }

  const status = accepted.length ? 'COMPLETE' : 'FAILED';
  const completedAt = new Date().toISOString();
  const record = {
    runId, company, startedAt, completedAt, durationMs: Date.now() - t0,
    resolved: resolution.resolved, resolvedUrl: resolution.url || null,
    providerId: resolution.providerId || null, method: resolution.method || null,
    status, fetched, accepted: accepted.length, canonicalKeys, errors,
    persisted,
  };
  const dir = runsDir || (dataRoot ? join(dataRoot, 'data', 'scavenger') : null);
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'company-crawls.json');
      const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8') || '[]') : [];
      const list = Array.isArray(prev) ? prev : [];
      list.push(record);
      writeFileSync(file, JSON.stringify(list.slice(-50), null, 1));
    } catch { /* run record is advisory — crawl results stand alone */ }
  }
  return { ok: true, ...record, canonicalUrls };
}

/** Recent company crawl runs, newest first. */
export function listCompanyCrawls({ runsDir = null, dataRoot = null, limit = 20 } = {}) {
  const dir = runsDir || (dataRoot ? join(dataRoot, 'data', 'scavenger') : null);
  if (!dir) return [];
  try {
    const file = join(dir, 'company-crawls.json');
    if (!existsSync(file)) return [];
    const list = JSON.parse(readFileSync(file, 'utf-8') || '[]');
    return (Array.isArray(list) ? list : []).slice(-limit).reverse();
  } catch {
    return [];
  }
}
