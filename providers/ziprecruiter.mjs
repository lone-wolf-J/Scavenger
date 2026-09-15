// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// ZipRecruiter provider — public candidate search at
// https://www.ziprecruiter.com/candidate/search.
// No official public API (partner API is gated); parses the public search
// page. ZipRecruiter serves heavy JS + bot checks, so BLOCKED is a common
// honest outcome — reported, never faked.
//
// Wire in via a `job_boards:` entry with `provider: ziprecruiter`.

import { cleanText, BROWSER_UA, throwIfBlocked } from './_board-html.mjs';

const BASE_URL = 'https://www.ziprecruiter.com/candidate/search';

/**
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string, source: string}>}
 */
export function parseZipRecruiterHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];
  // Result cards link to /jobs/<slug> or /job/<id> pages.
  const anchorRe = /<a[^>]+href="((?:https?:\/\/[^"]*ziprecruiter\.com)?\/jobs?\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const title = cleanText(match[2]);
    if (!title || title.length < 3) continue;
    const url = match[1].startsWith('http') ? match[1].split('?')[0] : `https://www.ziprecruiter.com${match[1].split('?')[0]}`;
    const rest = html.slice(match.index, match.index + 4000);
    const coMatch = rest.match(/data-testid="hiring-company"[^>]*>([\s\S]*?)<\//i)
      || rest.match(/<(?:p|div|span)[^>]*class="[^"]*(?:company|hiring)[^"]*"[^>]*>([\s\S]*?)<\//i);
    const locMatch = rest.match(/data-testid="job-location"[^>]*>([\s\S]*?)<\//i)
      || rest.match(/<(?:p|div|span)[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\//i);
    jobs.push({
      title,
      url,
      company: coMatch ? cleanText(coMatch[1]) : '',
      location: locMatch ? cleanText(locMatch[1]) : '',
      source: 'ziprecruiter',
    });
  }
  const seen = new Set();
  return jobs.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}

/** @type {Provider} */
export default {
  id: 'ziprecruiter',

  detect(entry) {
    return entry?.provider === 'ziprecruiter' ? { url: BASE_URL } : null;
  },

  async fetch(entry, ctx) {
    const query = entry.query || entry.search || 'software engineer';
    const location = entry.location || 'United States';
    const params = new URLSearchParams({ search: query, location });
    const url = `${BASE_URL}?${params.toString()}`;
    const html = await ctx.fetchText(url, { headers: { 'User-Agent': BROWSER_UA } });
    throwIfBlocked(html, 'ziprecruiter');
    return parseZipRecruiterHtml(html);
  },
};
