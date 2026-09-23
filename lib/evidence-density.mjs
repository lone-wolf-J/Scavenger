// Evidence-density measurement (Phase 12 §7): how much matchable evidence
// real postings carry. Tests the Phase 11 hypothesis ("thin synthetic JDs
// caused under-scoring") with counts, not conclusions. Patterns are generic
// seniority/credential vocabulary already present in the product — never
// profession-specific term lists.

import { seniorityOf } from './match-score.mjs';

const YEARS_RE = /\b\d{1,2}\+?\s*(?:years?|yrs?)\b/i;
const DEGREE_RE = /\b(?:bachelor'?s?|master'?s?|mba|ph\.?d\.?|b\.?s\.?|m\.?s\.?|associate'?s?(?: degree)?|doctorate)\b/i;
const CERT_RE = /\bcertif\w*\b/i;
const SENIORITY_RE = /\b(senior|sr\.?|lead|principal|staff|junior|jr\.?|entry|intern|director|vp|head|manager|executive|chief|president)\b/i;
const LEADERSHIP_RE = /\b(led|lead|leading|manage|managing|mentor|supervis|director|head of|vice president)\b/i;

/** Density signals for one record. All fields presence-checked, never inferred. */
export function recordDensity(rec = {}) {
  const desc = typeof rec.description === 'string' ? rec.description : '';
  const title = String(rec.title || '');
  return {
    evaluationId: rec.evaluationId || null,
    fields: {
      title: !!title.trim(),
      company: !!(rec.company && String(rec.company).trim()),
      location: !!(rec.location && String(rec.location).trim()),
      salary: rec.salary?.min != null,
      description: desc.length > 0,
      employmentType: !!rec.employmentType,
      workplaceType: !!rec.workplaceType,
      postedAt: typeof rec.postedAt === 'number',
    },
    descriptionLength: desc.length,
    signals: {
      yearsMention: YEARS_RE.test(`${title} ${desc}`),
      degreeMention: DEGREE_RE.test(desc),
      certificationMention: CERT_RE.test(desc),
      seniorityWord: SENIORITY_RE.test(title),
      leadershipWord: LEADERSHIP_RE.test(`${title} ${desc}`),
      seniorityLevel: seniorityOf(title),
    },
  };
}

/** Aggregate density over a corpus. Rates only; no quality verdicts. */
export function measureEvidenceDensity({ records = [] } = {}) {
  const rows = (Array.isArray(records) ? records : []).map(recordDensity);
  const fields = {};
  for (const name of ['title', 'company', 'location', 'salary', 'description', 'employmentType', 'workplaceType', 'postedAt']) {
    const present = rows.filter((r) => r.fields[name]).length;
    fields[name] = { present, total: rows.length, rate: rows.length ? present / rows.length : null };
  }
  const signals = {};
  for (const name of ['yearsMention', 'degreeMention', 'certificationMention', 'seniorityWord', 'leadershipWord']) {
    const present = rows.filter((r) => r.signals[name]).length;
    signals[name] = { present, total: rows.length, rate: rows.length ? present / rows.length : null };
  }
  const lens = rows.filter((r) => r.descriptionLength > 0).map((r) => r.descriptionLength).sort((a, b) => a - b);
  return {
    records: rows.length,
    fields,
    signals,
    descriptionLength: {
      withDescription: lens.length,
      average: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : null,
      median: lens.length ? lens[Math.floor(lens.length / 2)] : null,
    },
  };
}
