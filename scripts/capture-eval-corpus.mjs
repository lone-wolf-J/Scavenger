// capture-eval-corpus.mjs — build a versioned real-posting evaluation corpus.
// (run manually, not part of test-all)
//
// Usage: node scripts/capture-eval-corpus.mjs <outDir> [--limit 120]
//
// Bounded live fetches through OUR OWN provider adapters (dice search,
// greenhouse board) — no arbitrary scraping. Records are trimmed to the
// corpus schema, PII-rejected, and written with version metadata:
//   <outDir>/corpus.json   { meta, records }
// A new capture is a new version: pass a fresh outDir, never overwrite.
//
// Copyright: job postings belong to their posters; stored fields are the
// minimum needed for evaluation (title/company/location/description).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCorpusRecord, validateCorpusRecord, buildCorpusMetadata } from '../lib/eval-corpus.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('outDir required');
const limitArg = process.argv.find((a) => a.startsWith('--limit'));
const LIMIT = limitArg ? Number(limitArg.split('=')[1] || 120) : 120;

const QUERIES = [
  ['dice', { query: '"Senior Backend Engineer" Python', location: 'United States' }],
  ['dice', { query: '"Account Executive" SaaS', location: 'United States' }],
  ['dice', { query: '"Program Manager" software', location: 'United States' }],
  ['dice', { query: '"Finance Manager" FP&A', location: 'United States' }],
  ['dice', { query: '"VP People" talent', location: 'United States' }],
];
const GH_BOARD = { name: 'Anthropic', api: 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs' };

const ctx = { ...makeHttpCtx() };
const seen = new Set();
const records = [];
let n = 0;
const take = (providerId, job) => {
  const url = String(job?.url || '');
  if (!url || seen.has(url)) return;
  if (n >= LIMIT) return;
  n++;
  seen.add(url);
  const rec = normalizeCorpusRecord(job, { source: providerId, evaluationId: `corpus-v1-${String(n).padStart(4, '0')}` });
  const check = validateCorpusRecord(rec);
  if (!check.ok) {
    console.log(`reject ${url}: ${check.errors.join('; ')}`);
    return;
  }
  if (!rec.title) return;
  records.push(rec);
};

const dice = (await import('../providers/dice.mjs')).default;
for (const [, entry] of QUERIES) {
  try {
    const jobs = await dice.fetch(entry, ctx);
    for (const job of jobs) take('dice', job);
    console.log(`dice ${entry.query}: ${jobs.length} fetched`);
  } catch (err) {
    console.log(`dice ${entry.query} failed: ${err?.message || err}`);
  }
  if (n >= LIMIT) break;
}
if (n < LIMIT) {
  try {
    const gh = (await import('../providers/greenhouse.mjs')).default;
    const jobs = await gh.fetch(GH_BOARD, { fetchJson: ctx.fetchJson });
    for (const job of jobs.slice(0, LIMIT - n)) take('greenhouse', job);
    console.log(`greenhouse board: ${jobs.length} fetched`);
  } catch (err) {
    console.log(`greenhouse failed: ${err?.message || err}`);
  }
}

const window = { start: new Date(Date.now() - 3600_000).toISOString(), end: new Date().toISOString() };
const meta = buildCorpusMetadata({
  version: 'v1', records,
  profileCoverage: ['eval-software-eng', 'eval-sales', 'eval-program-mgmt', 'eval-finance', 'eval-hr-leadership'],
  captureWindow: window,
});
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'corpus.json'), JSON.stringify({ meta, records }, null, 2));
console.log(`wrote ${records.length} records → ${outDir}/corpus.json`);
