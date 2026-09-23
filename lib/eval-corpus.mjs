// Real-world evaluation corpus (Phase 12 §2–4, §9–10).
//
// Corpus records preserve ONLY evaluation-necessary fields from permitted
// sources (our own provider fetches, never arbitrary scraping). PII is
// rejected at validation: a record containing an email or phone-like string
// fails closed. Corpora are versioned and immutable — a new capture is a new
// version, results reference the version they ran against.
//
// Human evaluations are blind by construction: the record schema REJECTS
// score/band fields, so a label can never be anchored to a Scavenger score.

export const CORPUS_VERSION = 'v1';

const REQUIRED_RECORD_FIELDS = [
  'evaluationId', 'source', 'sourceJobId', 'title', 'location',
  'sourceUrl', 'capturedAt',
];
const OPTIONAL_RECORD_FIELDS = [
  'company', 'workplaceType', 'employmentType', 'postedAt', 'description',
];
// Company is optional: some boards omit the employer and the posting is
// still evaluable for role/location matching.
export const EVALUATION_LABELS = ['CLEAR_MATCH', 'PLAUSIBLE_MATCH', 'UNCLEAR', 'CLEAR_MISMATCH'];
const EVAL_DIMENSIONS = ['role', 'seniority', 'location', 'workplace', 'employment', 'skills', 'industry', 'other'];

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;

/** Validate one corpus record. Fails closed on PII or missing identity. */
export function validateCorpusRecord(rec) {
  const errors = [];
  if (!rec || typeof rec !== 'object') return { ok: false, errors: ['not an object'] };
  for (const f of REQUIRED_RECORD_FIELDS) {
    if (rec[f] == null || (typeof rec[f] === 'string' && !rec[f].trim())) errors.push(`missing ${f}`);
  }
  if (rec.description != null && typeof rec.description !== 'string') errors.push('description must be a string');
  if (rec.postedAt != null && typeof rec.postedAt !== 'number') errors.push('postedAt must be epoch ms');
  for (const text of [rec.title, rec.company, rec.description]) {
    if (typeof text === 'string' && (EMAIL_RE.test(text) || PHONE_RE.test(text))) {
      errors.push('record contains contact-like text (PII guard)');
      break;
    }
  }
  const known = new Set([...REQUIRED_RECORD_FIELDS, ...OPTIONAL_RECORD_FIELDS]);
  for (const k of Object.keys(rec)) {
    if (!known.has(k) && !k.startsWith('_')) errors.push(`unknown field ${k}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Provider-native id from a job URL when the adapter ships none. */
export function sourceIdFromUrl(url) {
  const s = String(url || '');
  let m = s.match(/\/job-detail\/([A-Za-z0-9-]+)/);
  if (m) return m[1];
  m = s.match(/\/jobs\/(\d+)/);
  if (m) return m[1];
  return '';
}

/** Trim a provider-shaped job to the corpus schema (description capped). */
export function normalizeCorpusRecord(raw, { source, evaluationId, capturedAt = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('corpus: raw job required');
  if (!source) throw new Error('corpus: source required');
  if (!evaluationId) throw new Error('corpus: evaluationId required');
  const url = String(raw.url || raw.sourceUrl || '');
  const nativeId = raw.sourceJobId ?? raw.id;
  return {
    evaluationId,
    source,
    sourceJobId: nativeId != null && String(nativeId) ? String(nativeId) : sourceIdFromUrl(url),
    title: String(raw.title || ''),
    company: raw.company != null ? String(raw.company) : null,
    location: String(raw.location || ''),
    workplaceType: raw.workplaceType != null ? String(raw.workplaceType) : null,
    employmentType: raw.employmentType != null ? String(raw.employmentType) : null,
    postedAt: typeof raw.postedAt === 'number' ? raw.postedAt : null,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 4000) : null,
    sourceUrl: String(raw.url || raw.sourceUrl || ''),
    capturedAt,
  };
}

/** Corpus metadata (§3). profileCoverage lists evaluated profile ids. */
export function buildCorpusMetadata({ version = CORPUS_VERSION, records = [], profileCoverage = [], captureWindow = null, createdAt = new Date().toISOString() } = {}) {
  const sourceCounts = {};
  for (const r of records) {
    if (r && r.source) sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;
  }
  return {
    corpusVersion: version,
    createdAt,
    recordCount: records.length,
    sourceCounts,
    profileCoverage: [...profileCoverage],
    captureWindow,
  };
}

/** Validate one blind human evaluation (§9–10). Scores are rejected. */
export function validateHumanEval(rec) {
  const errors = [];
  if (!rec || typeof rec !== 'object') return { ok: false, errors: ['not an object'] };
  for (const f of ['evaluationId', 'profileId', 'evaluationJobId', 'evaluationLabel', 'evaluatorId', 'evaluatedAt', 'corpusVersion']) {
    if (rec[f] == null || (typeof rec[f] === 'string' && !rec[f].trim())) errors.push(`missing ${f}`);
  }
  if (rec.evaluationLabel != null && !EVALUATION_LABELS.includes(rec.evaluationLabel)) {
    errors.push(`evaluationLabel must be one of ${EVALUATION_LABELS.join('|')}`);
  }
  if (rec.evaluationReasons != null) {
    if (!Array.isArray(rec.evaluationReasons)) errors.push('evaluationReasons must be an array');
    else {
      for (const r of rec.evaluationReasons) {
        if (!r || !EVAL_DIMENSIONS.includes(r.dimension)) { errors.push(`bad reason dimension in ${JSON.stringify(r)}`); break; }
        if (typeof r.note !== 'string' || !r.note.trim() || r.note.length > 280) { errors.push('reason notes are concise factual strings (≤280 chars)'); break; }
      }
    }
  }
  // Blindness: a human record carrying a score was labeled against the score.
  for (const f of ['score', 'band', 'scavengerScore', 'matchScore']) {
    if (rec[f] != null) errors.push(`forbidden field ${f} (labels stay independent of scores)`);
  }
  return { ok: errors.length === 0, errors };
}
