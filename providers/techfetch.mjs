// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// TechFetch provider — US tech-contract job board at https://www.techfetch.com.
// No official public API; parses the public search page. TechFetch serves
// staffing-driven listings, so employer names here are triaged by the
// discovery pipeline (staffing intermediaries go to review, not auto-add).
//
// Wire in via a `job_boards:` entry with `provider: techfetch`.

import { cleanText, BROWSER_UA, throwIfBlocked } from './_board-html.mjs';

const BASE_URL = 'https://www.techfetch.com/job-search';

/**
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string, source: string}>}
 */
export function parseTechFetchHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];
  // Detail links carry a numeric job id.
  const anchorRe = /<a[^>]+href="((?:https?:\/\/[^"]*techfetch\.com)?\/[^"]*job[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const title = cleanText(match[2]);
    if (!title || title.length < 3) continue;
    // Skip nav/listing chrome ("Browse Jobs", site nav).
    if (/^(browse|search|view all|find|all|home|jobs?)$/i.test(title)) continue;
    const rawHref = match[1].split('?')[0];
    if (/\/(jobs?|job-search)\/?$/i.test(rawHref)) continue;
    const url = match[1].startsWith('http') ? match[1].split('?')[0] : `https://www.techfetch.com${match[1].split('?')[0]}`;
    const rest = html.slice(match.index, match.index + 4000);
    const coMatch = rest.match(/<(?:p|div|span)[^>]*class="[^"]*(?:company|client|employer)[^"]*"[^>]*>([\s\S]*?)<\//i);
    const locMatch = rest.match(/<(?:p|div|span)[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\//i);
    jobs.push({
      title,
      url,
      company: coMatch ? cleanText(coMatch[1]) : '',
      location: locMatch ? cleanText(locMatch[1]) : '',
      source: 'techfetch',
    });
  }
  const seen = new Set();
  return jobs.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}

/** @type {Provider} */
export default {
  id: 'techfetch',

  detect(entry) {
    return entry?.provider === 'techfetch' ? { url: BASE_URL } : null;
  },

  async fetch(entry, ctx) {
    const query = entry.query || entry.search || 'software engineer';
    const location = entry.location || 'United States';
    const params = new URLSearchParams({ search: query, location });
    const url = `${BASE_URL}?${params.toString()}`;
    const html = await ctx.fetchText(url, { headers: { 'User-Agent': BROWSER_UA } });
    throwIfBlocked(html, 'techfetch');
    return parseTechFetchHtml(html);
  },
};

