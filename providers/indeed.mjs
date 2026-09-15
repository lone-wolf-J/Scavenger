// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Indeed provider — public search results from https://www.indeed.com/jobs.
//
// No official public API (Indeed's API is partner-gated), so this parses the
// public server-rendered search page. Indeed is aggressively bot-guarded
// (Cloudflare); when blocked the fetch throws and the scan envelope reports
// BLOCKED rather than fake results.
//
// Wire in via a `job_boards:` entry with `provider: indeed`.

import { cleanText, BROWSER_UA, throwIfBlocked } from './_board-html.mjs';

const BASE_URL = 'https://www.indeed.com/jobs';

/**
 * Parses Indeed search HTML into normalized job objects.
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number, source: string}>}
 */
export function parseIndeedHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];
  // Job cards link via /rc/clk?... or /pagead/... anchors.
  const anchorRe = /<a[^>]+href="((?:\/rc\/clk|\/pagead\/)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const title = cleanText(match[2]);
    if (!title || title.length < 3) continue;
    // Canonicalize to the jk key: tracking params (&x=, &vjk=, ...) rotate
    // per impression, so the same posting would otherwise dedup as many jobs.
    const jk = match[1].match(/[?&]jk=([A-Za-z0-9]+)/);
    const url = jk
      ? `https://www.indeed.com/rc/clk?jk=${jk[1]}`
      : `https://www.indeed.com${match[1].split(/[?#]/)[0]}`;
    const rest = html.slice(match.index, match.index + 4000);
    const coMatch = rest.match(/data-testid="company-name"[^>]*>([\s\S]*?)<\/(?:span|div|a)>/i)
      || rest.match(/<span[^>]*class="[^"]*companyName[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const locMatch = rest.match(/data-testid="text-location"[^>]*>([\s\S]*?)<\/(?:div|span)>/i)
      || rest.match(/<div[^>]*class="[^"]*companyLocation[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    jobs.push({
      title,
      url,
      company: coMatch ? cleanText(coMatch[1]) : '',
      location: locMatch ? cleanText(locMatch[1]) : '',
      source: 'indeed',
    });
  }
  // Same posting linked twice (title + aria card) — keep first per URL.
  const seen = new Set();
  return jobs.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}

/** @type {Provider} */
export default {
  id: 'indeed',

  detect(entry) {
    return entry?.provider === 'indeed' ? { url: BASE_URL } : null;
  },

  async fetch(entry, ctx) {
    const query = entry.query || entry.search || 'software engineer';
    const location = entry.location || 'United States';
    const params = new URLSearchParams({ q: query, l: location, fromage: '7', limit: '50' });
    const url = `${BASE_URL}?${params.toString()}`;
    const html = await ctx.fetchText(url, { headers: { 'User-Agent': BROWSER_UA } });
    throwIfBlocked(html, 'indeed');
    return parseIndeedHtml(html);
  },
};
