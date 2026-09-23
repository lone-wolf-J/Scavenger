// Job change detection + lifecycle — local, deterministic, no LLM.
//
// States per canonical job:
//   NEW       — no previous record (first sighting).
//   CHANGED   — a MEANINGFUL field differs (see MEANINGFUL_FIELDS).
//   UNCHANGED — only volatile metadata moved (lastSeen, seenCount, sources,
//               urls) or nothing at all.
//   STALE     — lifecycle: lastSeen older than staleAfterDays (default 30).
//   CLOSED    — lifecycle: lastSeen older than closedAfterDays (default 120),
//               OR explicit closedEvidence from a verification pass.
//
// Lifecycle rules (documented, deterministic):
//   - A job is NEVER closed because one provider failed, or because a
//     provider is BLOCKED/UNSUPPORTED — absence of evidence is not evidence.
//     Only elapsed lastSeen time or explicit verification evidence closes.
//   - upsert() always refreshes lastSeen → an observed job is active.
//   - refreshLifecycle() ages untouched jobs; it never deletes anything.

export const MEANINGFUL_FIELDS = [
  'title', 'company', 'location', 'workplaceType', 'employmentType',
  'salary', 'description', 'url', 'postedAt',
];

export const DEFAULT_STALE_AFTER_DAYS = 30;
export const DEFAULT_CLOSED_AFTER_DAYS = 120;
const DAY_MS = 86_400_000;

/**
 * Deterministic description normalization before comparison:
 * HTML stripped, entities decoded, whitespace collapsed, lowercased,
 * tracking query params dropped from URLs, zero-width chars removed.
 */
export function normalizeDescription(text) {
  let s = String(text || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  s = s.replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } });
  // Drop tracking params from embedded URLs (volatile noise, not content).
  s = s.replace(/([?&])(utm_[^&\s]*|ref=[^&\s]*|fbclid=[^&\s]*)/gi, '$1').replace(/[?&](?=[\s"']|$)/g, '');
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.toLowerCase().replace(/\s+/g, ' ').trim();
  // Tag stripping leaves "word !" vs "word!" — punctuation spacing is noise.
  s = s.replace(/\s+([!?,.;:])/g, '$1').replace(/[?&]+$/g, '');
  return s;
}

export function descriptionHash(text) {
  const norm = normalizeDescription(text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < norm.length; i++) {
    h1 = Math.imul(h1 ^ norm.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 + norm.charCodeAt(i), 31);
  }
  return `${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}:${norm.length}`;
}

function salaryKey(salary) {
  if (!salary || typeof salary !== 'object') return '';
  return [salary.min ?? '', salary.max ?? '', (salary.currency || '').toUpperCase()].join('|');
}

function fieldEquals(field, a, b) {
  if (field === 'description') return descriptionHash(a) === descriptionHash(b);
  if (field === 'salary') return salaryKey(a) === salaryKey(b);
  return String(a ?? '') === String(b ?? '');
}

/**
 * Compare a stored canonical record against a fresh normalized job.
 * @returns {{jobId, state: 'NEW'|'CHANGED'|'UNCHANGED', changedFields: string[],
 *   previous: object|null, current: object, detectedAt: string}}
 * Descriptions are NOT duplicated: previous/current carry a hash + 200-char
 * excerpt instead of full text.
 */
export function diffJobs(previous, current, now = Date.now()) {
  const detectedAt = new Date(now).toISOString();
  const jobId = (current && (current.jobId || current.canonicalKey)) || (previous && previous.jobId) || '';
  if (!previous) {
    return { jobId, state: 'NEW', changedFields: [], previous: null, current: snapshotExcerpt(current), detectedAt };
  }
  const changedFields = MEANINGFUL_FIELDS.filter((f) => !fieldEquals(f, previous[f], current[f]));
  return {
    jobId,
    state: changedFields.length ? 'CHANGED' : 'UNCHANGED',
    changedFields,
    previous: snapshotExcerpt(previous),
    current: snapshotExcerpt(current),
    detectedAt,
  };
}

function snapshotExcerpt(job) {
  if (!job || typeof job !== 'object') return null;
  const desc = typeof job.description === 'string' ? job.description : '';
  return {
    title: job.title || '',
    company: job.company || '',
    location: job.location || '',
    url: job.url || '',
    postedAt: job.postedAt ?? null,
    descriptionHash: descriptionHash(desc),
    descriptionExcerpt: normalizeDescription(desc).slice(0, 200),
  };
}

/**
 * Lifecycle for one record. Explicit closedEvidence always wins; otherwise
 * pure lastSeen aging. Provider outcomes are NOT inputs — a dead provider
 * must never close a job.
 */
export function classifyLifecycle(record, { now = Date.now(), staleAfterDays = DEFAULT_STALE_AFTER_DAYS, closedAfterDays = DEFAULT_CLOSED_AFTER_DAYS } = {}) {
  if (record?.closedEvidence) return 'closed';
  const lastSeen = Number(record?.lastSeen) || 0;
  const ageDays = (now - lastSeen) / DAY_MS;
  if (ageDays > closedAfterDays) return 'closed';
  if (ageDays > staleAfterDays) return 'stale';
  return 'active';
}

/**
 * Age every record in the store; returns counts. Never deletes.
 * @returns {{active: number, stale: number, closed: number, transitioned: string[]}}
 */
export function refreshLifecycle(store, opts = {}) {
  const counts = { active: 0, stale: 0, closed: 0 };
  const transitioned = [];
  for (const [id, record] of Object.entries(store?.jobs || {})) {
    const next = classifyLifecycle(record, opts);
    if (record.lifecycle !== next) {
      transitioned.push(id);
      record.lifecycle = next;
      record.lifecycleAt = new Date(opts.now || Date.now()).toISOString();
    }
    counts[next]++;
  }
  return { ...counts, transitioned };
}
