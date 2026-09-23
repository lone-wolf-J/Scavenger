// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.
// Requests the board with `content=true` (#3175) so each posting carries its
// full body as plain-text `description`; scan.mjs's content_filter,
// country_eligibility filter and visa_filter all read that field, and without
// it every Greenhouse board passed those filters blind.

import { htmlToText } from './_html-to-text.mjs';

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

/** @param {string} url */
function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// ── Office enrichment ───────────────────────────────────────────────
// Some Greenhouse boards put the *work model* ("Hybrid", "In-Office",
// "Distributed") in location.name and keep the actual city in the separate
// offices[] array — which the /jobs list endpoint does not return. For those
// boards scan.mjs's location_filter never sees a city, so every role is
// evaluated against the string "Hybrid" and silently dropped. Same bug class
// as #1073 (Ashby dropping secondaryLocations), different provider.
//
// The city is recoverable from /v1/boards/{slug}/offices, which nests
// offices → departments → jobs and costs one extra request. That request is
// only worth making for boards that actually exhibit the pattern: boards
// already reporting real cities pay nothing (Datadog's /offices is 2.8MB).

const WORK_MODEL = /^(?:hybrid|in[-\s]?office|on[-\s]?site|distributed|remote|flexible)$/i;

/**
 * True when a location string carries a work model but no geography at all
 * ("Hybrid", "Distributed; Hybrid"). Anything with a place in it
 * ("Hybrid - London", "Remote (Canada)") is already filterable and is left
 * alone, so enrichment can never rewrite a location that was working.
 * @param {unknown} name
 */
export function isWorkModelOnly(name) {
  if (typeof name !== 'string') return false;
  const parts = name.split(';').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(p => WORK_MODEL.test(p));
}

/**
 * boards/{slug}/jobs → boards/{slug}/offices. Returns null for any other
 * shape (e.g. a single-job URL), which disables enrichment rather than
 * guessing at an endpoint.
 * @param {string} apiUrl
 */
export function officesUrlFor(apiUrl) {
  const m = apiUrl.match(/^(https:\/\/[^/]+\/v1\/boards\/[^/]+)\/jobs(?:$|[?#])/);
  return m ? `${m[1]}/offices` : null;
}

/**
 * Build jobId → Set(office names) by walking offices → departments → jobs.
 * A job listed under several offices collects all of them, which is how a
 * genuinely multi-site role keeps every city it is open to.
 * @param {any} json
 */
export function buildOfficeMap(json) {
  /** @type {Map<any, Set<string>>} */
  const map = new Map();
  /** @param {any} offices */
  const walk = (offices) => {
    if (!Array.isArray(offices)) return;
    for (const office of offices) {
      if (!office || typeof office !== 'object') continue;
      const name = typeof office.name === 'string' ? office.name.trim() : '';
      if (name) {
        for (const dept of Array.isArray(office.departments) ? office.departments : []) {
          for (const job of Array.isArray(dept?.jobs) ? dept.jobs : []) {
            if (!job || job.id == null) continue;
            if (!map.has(job.id)) map.set(job.id, new Set());
            map.get(job.id).add(name);
          }
        }
      }
      walk(office.children);
    }
  };
  walk(json?.offices);
  return map;
}

// ── Posting body → plain text ────────────────────────────────────────
// With content=true the list response embeds each posting's body as
// DOUBLE-encoded HTML: the JSON string carries entity-escaped markup
// (`&lt;p&gt;`), so the first decode pass reveals the real tags, and
// text-level entities (`&amp;`, `&#39;`) only become decodable once those
// tags are gone. That pipeline (and its rationale) now lives in
// _html-to-text.mjs, shared with the providers added in #3175's phase 2;
// this wrapper keeps greenhouse's tested export name.

/**
 * Entity-decoded markup → stripped plain text. Exported for tests.
 * @param {unknown} content
 */
export function contentToText(content) {
  return htmlToText(content);
}

// ── Liveness verification ────────────────────────────────────────────
// Selection rationale (Phase 10 §2): Greenhouse has a per-posting public
// JSON API with deterministic semantics observed live 2026-09-18 —
//   GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}
//   → 200 + {id, absolute_url, title, …}  = posting exists (ACTIVE)
//   → 404 + {"status":404,"error":"Job not found"} = posting gone (NOT_FOUND)
// Numeric stable IDs, an existing high-quality adapter (this file), and
// fixtures below. Lever was rejected (public-API 404s on live Confidential
// postings — api404Authoritative:false); Ashby needs whole-board pulls;
// iCIMS/Indeed/Monster/CareerBuilder have no characterized closed semantics.

/**
 * Derive the per-posting boards-api URL for a stored job, or null when the
 * job carries no verifiable Greenhouse posting URL. Only on-host board URLs
 * are accepted; the EU board host maps to no known API host and yields
 * UNKNOWN rather than a guessed endpoint.
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
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'boards.greenhouse.io' && host !== 'job-boards.greenhouse.io') return null;
  const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/);
  if (!m) return null;
  return `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`;
}

/**
 * Pure classifier over a per-posting API response. Exported for tests and
 * the precision-eval framework (lib/verify-eval.mjs); verifyJob() is a thin
 * fetch + evidence wrapper around it. Greenhouse serves no distinct
 * "closed" state — removed postings 404 — so this classifier never returns
 * CLOSED; absence stays an observation (reliableAbsence: false below).
 * @param {{status: number, json?: any, url?: string}} res
 * @returns {{status: string, evidenceType: string, confidence: string, reason: string, jobTitle?: string}}
 */
export function classifyGreenhouseDetail({ status, json = null, url = '' }) {
  const where = url || 'detail API';
  if (status === 404) {
    return { status: 'NOT_FOUND', evidenceType: 'not_found_api', confidence: 'high', reason: `HTTP 404 from ${where}` };
  }
  if (status === 403) {
    return { status: 'BLOCKED', evidenceType: 'blocked_page', confidence: 'high', reason: `HTTP 403 from ${where}` };
  }
  if (status === 429) {
    return { status: 'RATE_LIMITED', evidenceType: 'provider_error', confidence: 'high', reason: `HTTP 429 from ${where}` };
  }
  if (Number.isInteger(status) && status >= 500 && status <= 599) {
    return { status: 'TEMPORARILY_UNAVAILABLE', evidenceType: 'provider_error', confidence: 'medium', reason: `HTTP ${status} from ${where}` };
  }
  if (status !== 200) {
    return { status: 'UNKNOWN', evidenceType: 'unparseable', confidence: 'low', reason: `unexpected HTTP ${status} from ${where}` };
  }
  const id = json?.id;
  const title = typeof json?.title === 'string' ? json.title.trim().slice(0, 120) : '';
  if ((typeof id === 'number' || typeof id === 'string') && String(id) && title) {
    return { status: 'ACTIVE', evidenceType: 'api_record_active', confidence: 'high', reason: 'detail API returns the posting record', jobTitle: title };
  }
  return { status: 'UNKNOWN', evidenceType: 'unparseable', confidence: 'low', reason: 'detail API response carries no posting record' };
}

/** @type {Provider} */
export default {
  id: 'greenhouse',

  // The boards-api 404 looks authoritative, but no measured precision exists
  // yet — and Lever proved an authoritative-looking ATS 404 can lie. NOT_FOUND
  // stays an observation until the §6–7 gate is satisfied (Phase 10).
  verify: { reliableAbsence: false },

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    // content=true embeds each posting's body in the list response (one
    // request, no per-job detail fetches). searchParams.set is idempotent, so
    // an entry.api that already pins the param can't end up with a duplicate.
    const listUrl = new URL(apiUrl);
    listUrl.searchParams.set('content', 'true');
    // Re-validate the final href: the guard chain runs on the exact string
    // that goes over the wire, not just the pre-param base.
    const listHref = assertGreenhouseUrl(listUrl.href);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    const json = /** @type {any} */ (await ctx.fetchJson(listHref, { redirect: 'error' }));
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    const usable = jobs.filter(/** @param {any} j */ j => j.absolute_url);

    // Only pay for /offices when this board actually hides its cities there.
    let officeMap = null;
    if (usable.some(/** @param {any} j */ j => isWorkModelOnly(j.location?.name))) {
      const officesUrl = officesUrlFor(apiUrl);
      if (officesUrl) {
        try {
          assertGreenhouseUrl(officesUrl);
          officeMap = buildOfficeMap(await ctx.fetchJson(officesUrl, { redirect: 'error' }));
        } catch (err) {
          // No /offices on this board, or it failed — fall back to the bare
          // work-model string. Enrichment is best-effort; a scan must never
          // fail because the secondary lookup did. Logged so a persistent
          // regression is distinguishable from a board that simply has no
          // /offices, which is expected and harmless.
          // `err` is not guaranteed to be an Error — a promise may reject with
          // anything, and reading .message off null would throw *inside* the
          // catch, defeating the guarantee above.
          const cause = err instanceof Error ? err.message : String(err);
          console.error(`⚠️  greenhouse: ${entry.name} /offices enrichment failed — ${cause} (keeping work-model-only locations)`);
          officeMap = null;
        }
      }
    }

    return usable.map(/** @param {any} j */ (j) => {
      let location = j.location?.name || '';
      if (officeMap && isWorkModelOnly(location)) {
        const offices = officeMap.get(j.id);
        if (offices && offices.size > 0) location = [location, ...offices].join(' · ');
      }
      const description = contentToText(j.content);
      return {
        title: j.title || '',
        url: j.absolute_url,
        company: entry.name,
        location,
        // Omitted entirely when the board ships no body — same shape as
        // cryptocurrencyjobs/remotli, so "no signal" stays distinguishable
        // from an empty string downstream.
        ...(description ? { description } : {}),
        postedAt: toEpochMs(j.first_published),
      };
    });
  },

  /**
   * Liveness check for ONE known posting (providers/_types.js VerifyResult).
   * One boards-api request. ACTIVE only for a 200 record carrying the posting
   * id + title; NOT_FOUND for HTTP 404; HTTP errors map terminally (no retry
   * into 429s); transport errors rethrow so lib/liveness-engine.mjs retries.
   */
  async verifyJob({ job, ctx }) {
    const url = detailUrlForJob(job);
    const observedAt = new Date().toISOString();
    if (!url) {
      return {
        status: 'UNKNOWN',
        evidence: {
          type: 'unparseable',
          provider: 'greenhouse',
          source: String(job?.url || ''),
          observedAt,
          confidence: 'low',
          reason: 'job has no Greenhouse posting URL — cannot verify',
        },
      };
    }
    assertGreenhouseUrl(url);
    let status;
    let json = null;
    try {
      json = await ctx.fetchJson(url, { redirect: 'error' });
      status = 200;
    } catch (err) {
      if (err == null || typeof err.status !== 'number') throw err;
      status = err.status;
    }
    const c = classifyGreenhouseDetail({ status, json, url });
    return {
      status: c.status,
      evidence: {
        type: c.evidenceType,
        provider: 'greenhouse',
        source: url,
        observedAt,
        confidence: c.confidence,
        reason: c.reason,
        ...(c.jobTitle ? { pageTitle: c.jobTitle } : {}),
      },
    };
  },
};
