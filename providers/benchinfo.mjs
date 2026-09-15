// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// BenchInfo adapter — HONESTLY UNSUPPORTED as a job source.
//
// BenchInfo (benchinfo.com) is an H-1B salary-data / consulting-bench
// marketing site. It exposes no public job-search page, feed, or API that a
// zero-token scanner can legitimately consume. Rather than scraping an
// unrelated page or fabricating listings, this adapter declares UNSUPPORTED
// so scan reports show `benchinfo: UNSUPPORTED` with this explanation.
//
// If BenchInfo ever ships a public listings endpoint, implement fetch()
// against it here and flip SUPPORTED to true.
//
// Wire in via a `job_boards:` entry with `provider: benchinfo` (it will
// report UNSUPPORTED instead of returning jobs).

import { unsupported } from './_board-html.mjs';

export const SUPPORTED = false;

/** @type {Provider} */
export default {
  id: 'benchinfo',

  detect(entry) {
    return entry?.provider === 'benchinfo' ? { url: 'https://benchinfo.com' } : null;
  },

  async fetch() {
    throw unsupported(
      'benchinfo',
      'no public job-search page, feed, or API — H-1B salary-data site, not a consumable job source (UNSUPPORTED)',
    );
  },
};
