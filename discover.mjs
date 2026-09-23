#!/usr/bin/env node

/**
 * discover.mjs — scoped live discovery over the shared Discovery Engine.
 *
 * Same engine the web uses (lib/discovery-engine.mjs): intent → deduped
 * queries → scoped provider execution → normalize → US-only → freshness →
 * canonical dedup → job-store upsert → employer resolution → match.
 *
 * Usage:
 *   node discover.mjs --profiles <profiles.json> [--ids hr,swe]
 *     [--store <job-store.json>] [--max-age 7] [--max-queries 6]
 *     [--providers dice,linkedin] [--refresh] [--dry-run] [--json]
 *
 * profiles.json: [{id, profile}] or {profiles:[...]} or a workspace.json
 * (profiles + selectedProfileIds are honored with --ids unset).
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverForProfiles } from './lib/discovery-engine.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DATA_ROOT = getCareerOpsRoot();

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function loadProfilesArg(file, ids) {
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  const list = Array.isArray(raw) ? raw : raw.profiles || [];
  const wanted = ids ? new Set(ids.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  // Workspace shape: honor selectedProfileIds when --ids is unset.
  const selected = !wanted && Array.isArray(raw.selectedProfileIds) ? new Set(raw.selectedProfileIds) : wanted;
  return list
    .filter((p) => p && p.id && (!selected || selected.has(p.id)))
    .map((p) => ({ id: p.id, profile: p.profile || p }));
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const profilesFile = flagValue(args, '--profiles');
  if (!profilesFile) {
    console.error('Usage: node discover.mjs --profiles <profiles.json> [--ids a,b] [--store <path>] [--max-age 7] [--max-queries 6] [--providers dice,linkedin] [--refresh] [--dry-run] [--json]');
    process.exit(2);
  }
  const result = await discoverForProfiles({
    profiles: loadProfilesArg(profilesFile, flagValue(args, '--ids')),
    providers: flagValue(args, '--providers')?.split(',').map((s) => s.trim()).filter(Boolean),
    maxAgeDays: flagValue(args, '--max-age') ? Number(flagValue(args, '--max-age')) : undefined,
    maxQueries: flagValue(args, '--max-queries') ? Number(flagValue(args, '--max-queries')) : undefined,
    dataRoot: DATA_ROOT,
    jobStorePath: flagValue(args, '--store') || undefined,
    refresh: args.includes('--refresh'),
    dryRun: args.includes('--dry-run'),
  }).catch((err) => {
    console.error(`discovery failed [${err.code || 'ERROR'}]: ${err.message}`);
    process.exit(1);
  });
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    console.log(`Discovery ${result.status}: ${result.jobsAccepted} accepted (${result.jobsDiscovered} raw → ${result.funnel.us} US → ${result.funnel.fresh} fresh → ${result.funnel.unique} unique)`);
    for (const p of result.providers) {
      console.log(`  [${p.status.padEnd(22)}] ${p.id.padEnd(14)} raw ${p.raw} acc ${p.accepted} hiMatch ${p.highMatch} ${Math.round(p.runtimeMs)}ms`);
    }
    const top = [...result.matches].sort((a, b) => b.best.score - a.best.score).slice(0, 5);
    for (const m of top) console.log(`  ★ ${m.best.score} ${m.best.profileId}`);
    console.log(`Timings (ms): planning ${result.timings.planningMs}, providers ${result.timings.providerMs}, match ${result.timings.matchingMs}, total ${result.timings.totalMs}`);
  }
}
