// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Wellfound (formerly AngelList Talent) provider — parses SSR __NEXT_DATA__
// Apollo state on public job listing pages (zero-auth, no login).
//
// Wire in via a `job_boards:` entry with `provider: wellfound`.

const BASE_URL = 'https://wellfound.com/jobs';
const TRUSTED_HOST = 'wellfound.com';

/**
 * Extracts and normalizes job listings from Wellfound SSR page HTML.
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string, compensation?: string, postedAt?: number, source: string}>}
 */
export function parseWellfoundHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const apollo = data.props?.pageProps?.apolloState?.data;
  if (!apollo || typeof apollo !== 'object') return [];

  const jobs = [];
  const listingKeys = Object.keys(apollo).filter((k) => k.startsWith('JobListing:'));

  for (const key of listingKeys) {
    const listing = apollo[key];
    if (!listing || typeof listing !== 'object') continue;

    const title = typeof listing.title === 'string' ? listing.title.trim() : '';
    const id = listing.id;
    const slug = listing.slug || '';
    if (!title || !id) continue;

    let company = 'Startup';
    let companySlug = '';
    const startupRef = listing.startup?.__ref;
    if (startupRef && apollo[startupRef]) {
      const startup = apollo[startupRef];
      if (typeof startup.name === 'string') company = startup.name.trim();
      if (typeof startup.slug === 'string') companySlug = startup.slug.trim();
    }

    const url = companySlug
      ? `https://wellfound.com/company/${companySlug}/jobs/${id}-${slug}`
      : `https://wellfound.com/jobs/${id}-${slug}`;

    const locParts = [];
    if (Array.isArray(listing.locationNames)) {
      locParts.push(...listing.locationNames.filter(Boolean));
    }
    if (listing.remote && !locParts.some((l) => /remote/i.test(l))) {
      locParts.push('Remote');
    }
    const location = locParts.join(', ');

    let postedAt;
    if (typeof listing.liveStartAt === 'number' && listing.liveStartAt > 0) {
      // liveStartAt is epoch seconds in Apollo payload
      postedAt = listing.liveStartAt * 1000;
    }

    const compensation = typeof listing.compensation === 'string' ? listing.compensation.trim() : '';

    jobs.push({
      title,
      url,
      company,
      location,
      compensation,
      postedAt,
      source: 'wellfound',
    });
  }

  return jobs;
}

/** @type {Provider} */
export default {
  id: 'wellfound',

  detect(entry) {
    return entry?.provider === 'wellfound' ? { url: BASE_URL } : null;
  },

  async fetch(entry, ctx) {
    const query = entry.query || entry.search || '';
    const url = query ? `${BASE_URL}?role=${encodeURIComponent(query)}` : BASE_URL;

    const html = await ctx.fetchText(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });

    return parseWellfoundHtml(html);
  },
};
