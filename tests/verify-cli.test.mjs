// verify.mjs CLI tests — dry-run, bounded limit, provider/job selection.
// Hermetic: fixture jobs use a source with NO verifyJob hook (no network),
// plus unknown-provider filtering. The CLI loads the real provider registry
// but never fetches here.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'verify.mjs');

const rec = (id) => ({
  jobId: id, title: 'Engineer', company: 'Acme', location: 'Austin, TX',
  url: `https://example.com/${id}`, source: 'nohook', sources: ['nohook'],
  postedAt: Date.now(), discoveredAt: Date.now(), firstSeen: Date.now(), lastSeen: Date.now(),
  seenCount: 1, lifecycle: 'active',
});

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scav-verify-cli-'));
  mkdirSync(join(root, 'data', 'scavenger'), { recursive: true });
  writeFileSync(join(root, 'data', 'scavenger', 'job-store.json'), JSON.stringify({
    version: 1, jobs: { k1: rec('k1'), k2: rec('k2'), k3: rec('k3') },
  }));
  writeFileSync(join(root, 'data', 'scavenger', 'history.json'), JSON.stringify({ version: 1, matches: {} }));
});

const runCli = (...args) => execFileSync('node', [CLI, '--dataRoot', root, ...args], { encoding: 'utf8', timeout: 120000 });

describe('verify CLI', () => {
  it('dry-run selects without writing', () => {
    const before = readFileSync(join(root, 'data', 'scavenger', 'job-store.json'), 'utf8');
    const out = runCli('--dry-run');
    assert.match(out, /Selected: 3/);
    // 'nohook' exposes no verifyJob: reported SKIPPED, never guessed.
    assert.match(out, /Skipped: 3/);
    assert.match(out, /Verified: 0/);
    assert.match(out, /no verifiable source/);
    assert.match(out, /dry-run: no writes performed/);
    assert.equal(readFileSync(join(root, 'data', 'scavenger', 'job-store.json'), 'utf8'), before);
  });

  it('bounds selection with --limit', () => {
    const out = runCli('--dry-run', '--limit', '1');
    assert.match(out, /Selected: 1/);
  });

  it('--job selects exactly one job; unhookable jobs persist nothing', () => {
    const out = runCli('--job', 'k2');
    assert.match(out, /Selected: 1/);
    assert.match(out, /Skipped: 1/);
    assert.match(out, /k2 \[—\] SKIPPED/);
    const store = JSON.parse(readFileSync(join(root, 'data', 'scavenger', 'job-store.json'), 'utf8'));
    assert.equal(store.jobs.k2.verificationHistory, undefined);
  });

  it('--provider with no hook-capable jobs selects nothing', () => {
    const out = runCli('--dry-run', '--provider', 'no-such-provider');
    assert.match(out, /Selected: 0/);
    assert.match(out, /Verified: 0/);
  });

  it('--json emits structured output without profile data', () => {
    const out = runCli('--dry-run', '--json', '--limit', '1');
    const parsed = JSON.parse(out);
    assert.equal(parsed.summary.selected, 1);
    assert.equal(parsed.dryRun, true);
    assert.ok(!JSON.stringify(parsed).includes('targetRoles'));
  });

  it('rejects bad limits with usage exit code', () => {
    assert.throws(() => runCli('--limit', '0'), /limit must be an integer/);
  });
});
