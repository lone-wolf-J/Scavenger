#!/usr/bin/env node

/**
 * review-queue.mjs — read-only discovery review queue inspector.
 *
 * Usage:
 *   node review-queue.mjs --summary   # human-readable pending-review table
 *   node review-queue.mjs --json      # machine-readable queue dump
 *
 * Never writes, never approves, never touches the tracker. Approving a
 * company into portals.yml stays a human decision.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DATA_ROOT = getCareerOpsRoot();
const REVIEW_PATH = process.env.CAREER_OPS_DISCOVERY_REVIEW || path.join(DATA_ROOT, 'data/discovery-review.json');

export function loadQueue(reviewPath = REVIEW_PATH) {
  if (!existsSync(reviewPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(reviewPath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function summarize(queue) {
  const pending = queue.filter((e) => (e.status || 'pending') === 'pending');
  const byConfidence = [...pending].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const lines = [];
  lines.push(`Discovery review queue: ${pending.length} pending (${queue.length} total)`);
  lines.push('');
  for (const e of byConfidence.slice(0, 50)) {
    lines.push(`- ${e.company || e.name} (confidence ${e.confidence}, via ${(e.sources || []).join(', ')})`);
    lines.push(`  Why discovered: ${e.whyDiscovered || `seen on ${(e.sources || []).join(', ')}`}`);
    lines.push(`  Why not auto-added: ${e.whyNotAutoAdded || 'below 0.8 threshold'}`);
    if (e.potentialCompanyUrl) lines.push(`  Potential company URL: ${e.potentialCompanyUrl}`);
    lines.push(`  Jobs found: ${e.jobsFound ?? e.jobCount ?? 0}${(e.relevantJobTitles || []).length ? ` — ${(e.relevantJobTitles || []).join('; ')}` : ''}`);
    lines.push(`  Evidence: ${(e.evidence || []).join('; ')}`);
  }
  if (byConfidence.length > 50) lines.push(`... and ${byConfidence.length - 50} more (use --json for the full list)`);
  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const queue = loadQueue();
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(queue, null, 2) + '\n');
  } else {
    console.log(summarize(queue));
    console.log('\nRead-only: approving a company into portals.yml stays a human decision.');
  }
}
