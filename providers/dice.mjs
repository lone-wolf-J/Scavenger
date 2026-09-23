// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Dice provider — parses public search results from https://www.dice.com/jobs.
//
// Wire in via a `job_boards:` entry with `provider: dice`.

import { decodeEntities } from './_html-entities.mjs';

const BASE_URL = 'https://www.dice.com/jobs';
const TRUSTED_HOST = 'www.dice.com';
const DETAIL_HOST_SUFFIX = 'dice.com';
const DICE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Parses relative recency text (e.g. "Today", "2 days ago") into approximate epoch ms.
 * @param {string} text
 * @returns {number|undefined}
 */
export function parseRelativeRecency(text) {
  if (!text) return undefined;
  const s = text.trim().toLowerCase();
  const now = Date.now();

  if (s.includes('today') || s.includes('just now') || s.includes('moment ago')) {
    return now;
  }
  if (s.includes('yesterday')) {
    return now - 86_400_000;
  }

  const hoursMatch = s.match(/(\d+)\+?\s*hour/);
  if (hoursMatch) {
    return now - Number(hoursMatch[1]) * 3_600_000;
  }

  const daysMatch = s.match(/(\d+)\+?\s*day/);
  if (daysMatch) {
    return now - Number(daysMatch[1]) * 86_400_000;
  }

  const weeksMatch = s.match(/(\d+)\+?\s*week/);
  if (weeksMatch) {
    return now - Number(weeksMatch[1]) * 7 * 86_400_000;
  }

  const monthsMatch = s.match(/(\d+)\+?\s*month/);
  if (monthsMatch) {
    return now - Number(monthsMatch[1]) * 30 * 86_400_000;
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Parses Dice public job search HTML into normalized job objects.
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string, compensation?: string, postedAt?: number, source: string}>}
 */
export function parseDiceHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];

  // Match link elements with data-testid="job-search-job-detail-link"
  const cardRegex = /<a[^>]*data-testid="job-search-job-detail-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=(?:<a[^>]*data-testid="job-search-job-detail-link"|$))/gi;

  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const rawUrl = match[1].trim();
    const title = decodeEntities(match[2].replace(/<[^>]+>/g, '')).trim();
    const rest = match[3] || '';

    if (!title || !rawUrl) continue;

    const fullUrl = rawUrl.startsWith('http')
      ? rawUrl.split('?')[0]
      : `https://www.dice.com${rawUrl.split('?')[0]}`;

    // Company name — empty when absent (never a fake "Dice Employer": the
    // board is not the employer; scan.mjs discovery skips empty names).
    const compMatch = rest.match(/data-testid="job-card-company-name"[^>]*>([\s\S]*?)<\/p>/i);
    const company = compMatch ? decodeEntities(compMatch[1].replace(/<[^>]+>/g, '')).trim() : '';

    // Location and posted date line
    let location = '';
    let postedAt;
    const locDateMatch = rest.match(/<p[^>]*class="[^"]*text-foreground-light[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (locDateMatch) {
      const parts = decodeEntities(locDateMatch[1].replace(/<!--.*?-->/g, ''))
        .split('•')
        .map((p) => p.trim());
      if (parts.length >= 2) {
        location = parts[0];
        postedAt = parseRelativeRecency(parts[1]);
      } else if (parts.length === 1) {
        location = parts[0];
      }
    }

    // Salary / compensation
    const salaryMatch = rest.match(/id="salary-label"[^>]*>([\s\S]*?)<\/p>/i);
    const compensation = salaryMatch ? decodeEntities(salaryMatch[1].replace(/<[^>]+>/g, '')).trim() : '';

    jobs.push({
      title,
      url: fullUrl,
      company,
      location,
      compensation,
      postedAt,
      source: 'dice',
    });
  }

  return jobs;
}

/**
 * Derive the canonical Dice job-detail URL for a stored job, or null when
 * the job carries no verifiable Dice detail URL. Rebuilding (instead of
 * trusting the stored string) keeps verification on-host: only
 * https://[www.]dice.com/job-detail/<id> is ever fetched (SSRF guard —
 * the provider DNS/IP guard in providers/_http.mjs still applies).
 * @param {{url?: string}} job
 * @returns {string|null}
 */
export function detailUrlForJob(job) {
  let u;
  try {
    u = new URL(String(job?.url || ''));
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'www.dice.com' && host !== 'dice.com') return null;
  const m = u.pathname.match(/^\/job-detail\/([A-Za-z0-9-]+)\/?$/);
  if (!m) return null;
  return `https://www.dice.com/job-detail/${m[1]}`;
}

// Markers observed live 2026-09-18 (see tests/fixtures/dice-verify/):
//   active    <title>{title} - {company} - {location} | Dice.com</title> + "Apply Now"
//   not-found HTTP 200 + <title>Job Not Found | Dice.com</title> (soft-404)
// No explicit expired/closed detail page was observed live; the CLOSED branch
// below covers standard closure phrasing IF Dice ever serves it, and is
// exercised by synthetic classifier tests (labeled as such) — live traffic
// decides whether it ever fires (see lib/verify-eval.mjs).
const NOT_FOUND_TITLE_RE = /job\s+not\s+found/i;
const EXPLICIT_CLOSED_RE = /job\s+expired|no longer available|position has been filled|no longer accepting/i;
const CHALLENGE_RE = /captcha|cloudflare|datadome|verify you are (a )?human|are you a robot|access denied|request blocked|unusual traffic/i;
const APPLY_RE = /apply now/i;
const DICE_TITLE_SUFFIX_RE = /\|\s*dice\.com\s*$/i;

/**
 * Pure classifier over a fetched detail response. Exported for tests and the
 * precision-eval framework (lib/verify-eval.mjs); verifyJob() is a thin
 * fetch + evidence wrapper around it.
 * @param {{status: number, html?: string, url?: string}} res
 * @returns {{status: string, evidenceType: string, confidence: string, reason: string, pageTitle?: string}}
 */
export function classifyDiceDetailPage({ status, html = '', url = '' }) {
  const body = typeof html === 'string' ? html : '';
  if (status === 404) {
    return { status: 'NOT_FOUND', evidenceType: 'not_found_page', confidence: 'high', reason: `HTTP 404 from ${url || 'detail page'}` };
  }
  if (status === 403) {
    return { status: 'BLOCKED', evidenceType: 'blocked_page', confidence: 'high', reason: `HTTP 403 from ${url || 'detail page'}` };
  }
  if (status === 429) {
    return { status: 'RATE_LIMITED', evidenceType: 'provider_error', confidence: 'high', reason: `HTTP 429 from ${url || 'detail page'}` };
  }
  if (Number.isInteger(status) && status >= 500 && status <= 599) {
    return { status: 'TEMPORARILY_UNAVAILABLE', evidenceType: 'provider_error', confidence: 'medium', reason: `HTTP ${status} from ${url || 'detail page'}` };
  }
  if (status !== 200) {
    return { status: 'UNKNOWN', evidenceType: 'unparseable', confidence: 'low', reason: `unexpected HTTP ${status} from ${url || 'detail page'}` };
  }
  const titleMatch = body.match(/<title>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (!pageTitle) {
    return { status: 'UNKNOWN', evidenceType: 'unparseable', confidence: 'low', reason: 'detail page has no <title>' };
  }
  if (NOT_FOUND_TITLE_RE.test(pageTitle)) {
    return { status: 'NOT_FOUND', evidenceType: 'not_found_page', confidence: 'high', reason: 'detail page title "Job Not Found"', pageTitle };
  }
  if (EXPLICIT_CLOSED_RE.test(body)) {
    return { status: 'CLOSED', evidenceType: 'explicit_closed_marker', confidence: 'high', reason: 'detail page carries an explicit closure marker', pageTitle };
  }
  if (CHALLENGE_RE.test(body)) {
    return { status: 'BLOCKED', evidenceType: 'blocked_page', confidence: 'medium', reason: 'detail page carries a bot-challenge marker', pageTitle };
  }
  if (APPLY_RE.test(body) && DICE_TITLE_SUFFIX_RE.test(pageTitle)) {
    return { status: 'ACTIVE', evidenceType: 'detail_page_active', confidence: 'high', reason: 'detail page shows Apply marker with Dice title', pageTitle };
  }
  return { status: 'UNKNOWN', evidenceType: 'unparseable', confidence: 'low', reason: 'detail page matches no known marker set', pageTitle };
}

/** @type {Provider} */
export default {
  id: 'dice',

  // NOT_FOUND is NOT a reliable closure signal for Dice: the detail page
  // soft-404s with HTTP 200 ("Job Not Found | Dice.com"), so absence must
  // stay an observation until live precision is demonstrated (Phase 9 §4).
  verify: { reliableAbsence: false },

  detect(entry) {
    return entry?.provider === 'dice' ? { url: BASE_URL } : null;
  },

  async fetch(entry, ctx) {
    const query = entry.query || entry.search || 'marketing';
    const location = entry.location || 'United States';
    const params = new URLSearchParams({
      q: query,
      location,
    });

    const url = `${BASE_URL}?${params.toString()}`;
    const html = await ctx.fetchText(url, {
      headers: {
        'User-Agent': DICE_UA,
      },
    });

    return parseDiceHtml(html);
  },

  /**
   * Liveness check for ONE known posting (providers/_types.js VerifyResult).
   * Cheap (one request) and honest: ACTIVE only for positive existence proof
   * (detail title + Apply marker), CLOSED only for an explicit closure
   * marker, NOT_FOUND for the "Job Not Found" page or HTTP 404. Anything
   * unrecognized is UNKNOWN — never guessed. Transport errors (no HTTP
   * status) are rethrown so lib/liveness-engine.mjs can retry them; HTTP
   * errors are returned as terminal observations (no retry into 429s).
   */
  async verifyJob({ job, ctx }) {
    const url = detailUrlForJob(job);
    const observedAt = new Date().toISOString();
    if (!url) {
      return {
        status: 'UNKNOWN',
        evidence: {
          type: 'unparseable',
          provider: 'dice',
          source: String(job?.url || ''),
          observedAt,
          confidence: 'low',
          reason: 'job has no Dice job-detail URL — cannot verify',
        },
      };
    }
    let status;
    let html = '';
    try {
      html = await ctx.fetchText(url, { headers: { 'User-Agent': DICE_UA } });
      status = 200;
    } catch (err) {
      if (err == null || typeof err.status !== 'number') throw err;
      status = err.status;
    }
    const c = classifyDiceDetailPage({ status, html, url });
    return {
      status: c.status,
      evidence: {
        type: c.evidenceType,
        provider: 'dice',
        source: url,
        observedAt,
        confidence: c.confidence,
        reason: c.reason,
        ...(c.pageTitle ? { pageTitle: c.pageTitle } : {}),
      },
    };
  },
};
