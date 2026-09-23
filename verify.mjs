// verify.mjs — bounded liveness verification over known canonical jobs.
//
// Usage:
//   node verify.mjs [--dataRoot <dir>] [--limit 25] [--provider dice]
//                   [--job <canonicalId>] [--dry-run] [--json]
//
// Selects verification candidates (saved/applied first — never excluded by
// age), verifies each hook-capable source (one request per job per source),
// records compact evidence, and persists atomically. Discovery and
// verification stay separate: this command never searches for new jobs.
//
// Dry-run performs NO persistent writes. Output prints job ids + statuses
// only — never profile data, resume text, or raw provider bodies.

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { flagValue, hasFlag, safeIntFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { verifyExistingJobs } from './lib/verify-service.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage:
  node verify.mjs [--dataRoot <dir>] [--limit 25] [--provider <id>] [--job <id>] [--dry-run] [--json]

  --dataRoot <dir>  career-ops root (default: this checkout). Reads
                    <root>/data/scavenger/job-store.json + history.json.
  --limit <n>       max jobs to verify (default 25, max 1000).
  --provider <id>   restrict to one provider (default: all hook-capable).
  --job <id>        verify exactly one canonical job id.
  --dry-run         select + verify, persist nothing.
  --json            print the full structured result as JSON.`;

export async function main(args = process.argv.slice(2)) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(USAGE);
    return { code: 0 };
  }
  const dataRoot = flagValue(args, '--dataRoot') || HERE;
  const limit = safeIntFlag(flagValue(args, '--limit'), 25);
  const provider = flagValue(args, '--provider') || null;
  const jobId = flagValue(args, '--job') || null;
  const dryRun = hasFlag(args, '--dry-run');
  const asJson = hasFlag(args, '--json');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    console.error(`${USAGE}\n\nerror: --limit must be an integer 1..1000`);
    return { code: 2 };
  }

  const storePath = join(dataRoot, 'data', 'scavenger', 'job-store.json');
  const historyPath = join(dataRoot, 'data', 'scavenger', 'history.json');
  let histories = {};
  try {
    const { readFileSync } = await import('fs');
    histories = JSON.parse(readFileSync(historyPath, 'utf8')).matches || {};
  } catch {
    histories = {};
  }

  const out = await verifyExistingJobs({
    storePath, histories, limit, provider, jobId, dryRun,
  });

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return { code: 0 };
  }
  const s = out.summary;
  console.log(`Selected: ${s.selected}`);
  console.log(`Verified: ${s.verified}`);
  console.log(`Skipped: ${s.skipped}`);
  console.log(`ACTIVE: ${s.active}`);
  console.log(`CLOSED: ${s.closed}`);
  console.log(`NOT_FOUND: ${s.notFound}`);
  console.log(`UNKNOWN: ${s.unknown}`);
  console.log(`FAILED: ${s.failed}`);
  if (dryRun) console.log('(dry-run: no writes performed)');
  else console.log(out.persisted ? '(persisted atomically)' : '(nothing to persist)');
  for (const r of out.results) {
    const who = r.provider ? `[${r.provider}]` : '[—]';
    const extra = r.status === 'SKIPPED' ? ' (no verifiable source)' : (r.closed ? ' → CLOSED' : '');
    console.log(`  ${r.jobId} ${who} ${r.status}${extra}`);
  }
  return { code: 0 };
}

if (isMainModule(import.meta.url)) {
  const { code } = await main().catch((err) => {
    console.error(`verify failed: ${err?.message || err}`);
    return { code: 1 };
  });
  process.exitCode = code;
}
