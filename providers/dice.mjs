// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Dice provider — parses public search results from https://www.dice.com/jobs.
//
// Wire in via a `job_boards:` entry with `provider: dice`.

import { decodeEntities } from './_html-entities.mjs';

const BASE_URL = 'https://www.dice.com/jobs';
const TRUSTED_HOST = 'www.dice.com';

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

/** @type {Provider} */
export default {
  id: 'dice',

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });

    return parseDiceHtml(html);
  },
};
