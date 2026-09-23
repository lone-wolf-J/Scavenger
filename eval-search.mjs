// eval-search.mjs — developer/evaluation-only search evaluation runner.
//
// Usage:
//   node eval-search.mjs [--profiles <dir>] [--providers a,b] [--maxQueries 6] [--json]
//
// Runs the five fixture career profiles (or a directory of compatible JSON
// profiles) through intent → discovery → match with REAL providers and
// reports descriptive measurements. DRY-RUN ALWAYS: evaluation never writes
// to the store or history. No tuning, no personalization, no persistence —
// measurement only. Not part of test-all.

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { evaluateProfileSearch, evaluateSearchAcrossProfiles } from './lib/search-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage:
  node eval-search.mjs [--profiles <dir>] [--providers <a,b>] [--maxQueries 6] [--json]

  --profiles <dir>   directory of {id, name, profile} JSON files
                     (default: tests/fixtures/eval-profiles).
  --providers <a,b>  provider ids (default: dice).
  --maxQueries <n>   query cap per run (default 6).
  --json             print full structured output as JSON.

  Always dry-run: reads providers live, persists nothing.`;

export async function main(args = process.argv.slice(2)) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(USAGE);
    return { code: 0 };
  }
  const profilesDir = flagValue(args, '--profiles') || join(HERE, 'tests', 'fixtures', 'eval-profiles');
  const providers = (flagValue(args, '--providers') || 'dice').split(',').map((s) => s.trim()).filter(Boolean);
  const maxQueries = Math.max(1, Math.min(12, Number(flagValue(args, '--maxQueries')) || 6));
  const asJson = hasFlag(args, '--json');

  const profiles = readdirSync(profilesDir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(profilesDir, f), 'utf8')));
  if (!profiles.length) {
    console.error('eval-search: no profiles found');
    return { code: 2 };
  }

  const perProfile = [];
  for (const p of profiles) {
    perProfile.push(await evaluateProfileSearch({
      profileId: p.id, profile: p.profile, providers, maxQueries,
    }));
  }
  const shared = await evaluateSearchAcrossProfiles({
    profiles, providers, maxQueries,
  });
  const out = {
    profiles: perProfile.map((e) => ({
      profileId: e.profileId,
      families: e.intent.families,
      queryCount: e.intent.queries.length,
      retrieved: e.retrieval.totals.retrieved,
      accepted: e.retrieval.totals.accepted,
      matched: e.matching.matched,
      strong: e.matching.strong,
      bands: e.matching.bands,
      gaps: e.gaps,
    })),
    sharedPlan: shared.sharedPlan,
    perProfileMatched: shared.perProfile,
  };

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return { code: 0 };
  }
  for (const p of out.profiles) {
    console.log(`${p.profileId}: families=[${p.families.join(', ')}] queries=${p.queryCount} retrieved=${p.retrieved} accepted=${p.accepted} matched=${p.matched} strong=${p.strong}`);
    if (p.gaps.zeroResultQueries) console.log(`  gap: ${p.gaps.zeroResultQueries} zero-result queries`);
    if (p.gaps.noStrongMatches) console.log('  gap: no strong matches');
    for (const f of p.gaps.failedProviders) console.log(`  gap: provider ${f.provider} failed (${f.errorType})`);
  }
  console.log(`shared plan: ${shared.sharedPlan.profiles} profiles → ${shared.sharedPlan.mergedQueries} merged queries (naive sum ${shared.sharedPlan.naivePerProfileSum}), shared=${shared.sharedPlan.shared}`);
  console.log('(dry-run: nothing persisted)');
  return { code: 0 };
}

if (isMainModule(import.meta.url)) {
  const { code } = await main().catch((err) => {
    console.error(`eval-search failed: ${err?.message || err}`);
    return { code: 1 };
  });
  process.exitCode = code;
}
