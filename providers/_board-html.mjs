// Shared helpers for public HTML job-board providers (explicit-provider
// boards: indeed, careerbuilder, monster, ziprecruiter, techfetch).
// Files prefixed with _ are never loaded as providers.

import { decodeEntities } from './_html-entities.mjs';

export { decodeEntities };

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Strip tags + decode entities + collapse whitespace. */
export function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const BLOCK_MARKERS = [
  'captcha',
  'cloudflare',
  'challenge-platform',
  'sign in to continue',
  'unusual traffic',
  'access denied',
  'are you a robot',
  'datadome',
  'perimeterx',
  'please verify you are a human',
];

/**
 * Throw a classified error when a 200 page is really a bot wall.
 * Sets err.body so classifyProviderError() sees the marker text.
 */
export function throwIfBlocked(html, providerId) {
  const lower = String(html || '').toLowerCase();
  if (BLOCK_MARKERS.some((m) => lower.includes(m))) {
    const err = new Error(`${providerId}: bot wall / access challenge detected`);
    err.body = String(html).slice(0, 2000);
    throw err;
  }
}

/** Mark a provider terminally unsupported (no legitimate public endpoint). */
export function unsupported(providerId, reason) {
  const err = new Error(`${providerId}: ${reason}`);
  err.providerErrorType = 'UNSUPPORTED';
  return err;
}
