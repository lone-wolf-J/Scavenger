// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn public guest search provider — zero-auth public endpoint.
// Endpoint: https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
// Query params:
//   keywords: search terms
//   location: country or metro (e.g. "United States", "Remote")
//   f_TPR: r604800 (past 7 days = 604800 seconds)
//   start: offset for pagination (0, 10, 20, ...)
//
// Wire in via a `job_boards:` entry with `provider: linkedin`.

import { decodeEntities } from './_html-entities.mjs';

const BASE_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const TRUSTED_HOST = 'www.linkedin.com';
const MAX_PAGES = 10;
const PAGE_SIZE = 10;
const INTER_PAGE_DELAY_MS = 1000;

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDateToEpoch(dateStr) {
  if (!dateStr) return undefined;
  const parsed = Date.parse(dateStr);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Parses LinkedIn public guest search HTML into normalized job objects.
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number, source: string}>}
 */
export function parseLinkedInGuestHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];

  // Match each <li> card
  const liBlocks = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];

  for (const block of liBlocks) {
    const titleMatch = block.match(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h3>/i);
    const linkMatch = block.match(/<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i);
    if (!titleMatch || !linkMatch) continue;

    const title = decodeEntities(titleMatch[1]).trim();
    const rawUrl = linkMatch[1].trim();
    const cleanUrl = rawUrl.split('?')[0];
    if (!title || !cleanUrl.startsWith('https://')) continue;

    const companyMatch = block.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i);
    let company = '';
    if (companyMatch) {
      // Strip any nested tags
      company = decodeEntities(companyMatch[1].replace(/<[^>]+>/g, '')).trim();
    }

    const locMatch = block.match(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const location = locMatch ? decodeEntities(locMatch[1].replace(/<[^>]+>/g, '')).trim() : '';

    const dateMatch = block.match(/<time[^>]*datetime="([^"]+)"/i);
    const postedAt = dateMatch ? parseDateToEpoch(dateMatch[1]) : undefined;

    jobs.push({
      title,
      url: cleanUrl,
      company,
      location,
      postedAt,
      source: 'linkedin',
    });
  }

  return jobs;
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  detect(entry) {
    return entry?.provider === 'linkedin' ? { url: BASE_URL } : null;
  },

  async fetch(entry, ctx) {
    const query = entry.query || entry.search || 'content marketing';
    const location = entry.location || 'United States';
    const maxPages = Number.isInteger(entry.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES)
      : 5;

    const allJobs = [];
    const seenUrls = new Set();

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      const params = new URLSearchParams({
        keywords: query,
        location,
        f_TPR: 'r604800', // Past 7 days
        start: String(page * PAGE_SIZE),
      });

      const url = `${BASE_URL}?${params.toString()}`;
      let html = '';
      try {
        html = await ctx.fetchText(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          },
        });
      } catch (err) {
        if (page === 0) throw err;
        console.error(`⚠️  linkedin: truncated at page ${page} (${allJobs.length} jobs gathered): ${err.message}`);
        break;
      }

      const pageJobs = parseLinkedInGuestHtml(html);
      if (pageJobs.length === 0) break;

      for (const job of pageJobs) {
        if (!seenUrls.has(job.url)) {
          seenUrls.add(job.url);
          allJobs.push(job);
        }
      }
    }

    return allJobs;
  },
};
