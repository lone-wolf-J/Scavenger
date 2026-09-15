// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Monster provider — public search at https://www.monster.com/jobs/search.
// No official public API; parses the server-rendered search page. Blocks
// surface as BLOCKED via the shared envelope, never as fake jobs.
//
// Wire in via a `job_boards:` entry with `provider: monster`.

import { cleanText, BROWSER_UA, throwIfBlocked } from './_board-html.mjs';

const BASE_URL = 'https://www.monster.com/jobs/search';

/**
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string, source: string}>}
 */
export function parseMonsterHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];
  // Cards link to /job-openings/<slug>--<id> detail pages.
  const anchorRe = /<a[^>]+href="((?:https?:\/\/[^"]*monster\.com)?\/job-openings\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const title = cleanText(match[2]);
    if (!title || title.length < 3) continue;
    const url = match[1].startsWith('http') ? match[1].split('?')[0] : `https://www.monster.com${match[1].split('?')[0]}`;
    const rest = html.slice(match.index, match.index + 4000);
    const coMatch = rest.match(/data-testid="(?:company|employer)-name"[^>]*>([\s\S]*?)<\//i)
      || rest.match(/<div[^>]*class="[^"]*(?:company|employer)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const locMatch = rest.match(/data-testid="location"[^>]*>([\s\S]*?)<\//i)
      || rest.match(/<div[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    jobs.push({
      title,
      url,
      company: coMatch ? cleanText(coMatch[1]) : '',
      location: locMatch ? cleanText(locMatch[1]) : '',
      source: 'monster',
    });
  }
  const seen = new Set();
  return jobs.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}

/** @type {Provider} */
export default {
  id: 'monster',

  detect(entry) {
    return entry?.provider === 'monster' ? { url: BASE_URL } : null;
  },

  async fetch(entry, ctx) {
    const query = entry.query || entry.search || 'software engineer';
    const location = entry.location || 'United States';
    const params = new URLSearchParams({ q: query, where: location });
    const url = `${BASE_URL}?${params.toString()}`;
    const html = await ctx.fetchText(url, { headers: { 'User-Agent': BROWSER_UA } });
    throwIfBlocked(html, 'monster');
    return parseMonsterHtml(html);
  },
};
