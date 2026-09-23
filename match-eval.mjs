// match-eval.mjs — human-auditable match evaluation CLI (Phase 11 §21).
//
// Usage:
//   node match-eval.mjs [--fixture <path>] [--profile <id>] [--json] [--verbose]
//
// Runs the labeled evaluation set through the real scorer + diagnostics and
// reports per-case retrieval status (match-stage: MATCHED_LOW/HIGH for cases
// that reach matching), score, band, contributors, penalties, missing
// evidence, and the evaluation label — plus the set summary (label×band
// matrix, false negatives/positives, cause attribution).
//
// Fixtures only, no network, no PII. Never tunes anything.

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { evaluateMatchCase, summarizeEvalSet, isFalseNegative, isFalsePositive } from './lib/match-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage:
  node match-eval.mjs [--fixture <path>] [--profile <id>] [--json] [--verbose]

  --fixture <path>  evaluation cases JSON (default: tests/fixtures/match-eval-cases.json).
  --profile <id>    run only cases for one eval profile id.
  --json            print the full structured result as JSON.
  --verbose         print contributors, penalties, and missing evidence per case.`;

function loadProfiles() {
  const dir = join(HERE, 'tests', 'fixtures', 'eval-profiles');
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return [p.id, p.profile];
  }));
}

export async function main(args = process.argv.slice(2)) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(USAGE);
    return { code: 0 };
  }
  const fixturePath = flagValue(args, '--fixture') || join(HERE, 'tests', 'fixtures', 'match-eval-cases.json');
  const onlyProfile = flagValue(args, '--profile') || null;
  const asJson = hasFlag(args, '--json');
  const verbose = hasFlag(args, '--verbose');

  const profiles = loadProfiles();
  const set = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const cases = (set.cases || []).filter((c) => !onlyProfile || c.profileId === onlyProfile);
  if (!cases.length) {
    console.error('match-eval: no cases selected');
    return { code: 2 };
  }
  const results = cases.map((c) => ({
    ...evaluateMatchCase({ id: c.id, profileId: c.profileId, profile: profiles[c.profileId], job: c.job, expected: c.expected }),
    retrievalStatus: 'MATCHED_LOW',
  }));
  // Retrieval status for fixture cases: they reach matching by construction;
  // the funnel stage is the match band itself (pipeline retrieval is traced
  // separately via classifyRetrievalStatus in tests).
  for (const r of results) r.retrievalStatus = r.score >= 75 ? 'MATCHED_HIGH' : 'MATCHED_LOW';
  const summary = summarizeEvalSet(results);
  const out = { results, summary };

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return { code: 0 };
  }
  for (const r of results) {
    const flag = isFalseNegative(r) ? ' [FALSE NEGATIVE]' : isFalsePositive(r) ? ' [FALSE POSITIVE]' : '';
    console.log(`${r.id} [${r.expected.relevance}] score=${r.score} band=${r.band} retrieval=${r.retrievalStatus}${flag}`);
    if (verbose) {
      console.log(`  ${r.diagnostic.explanation}`);
      if (r.penalties.length) console.log(`  penalties: ${r.penalties.join(' | ')}`);
      if (r.diagnostic.missingEvidence.length) {
        console.log(`  missing: ${r.diagnostic.missingEvidence.slice(0, 4).join(' | ')}`);
      }
    }
  }
  console.log(`cases=${results.length} falseNegatives=${summary.falseNegatives.length} falsePositives=${summary.falsePositives.length}`);
  return { code: 0 };
}

if (isMainModule(import.meta.url)) {
  const { code } = await main().catch((err) => {
    console.error(`match-eval failed: ${err?.message || err}`);
    return { code: 1 };
  });
  process.exitCode = code;
}
