// Phase 10 HTTP E2E — second-provider (greenhouse) verification, live.
// (run manually, not part of test-all)
//   1. fixture root = full checkout shape (junctions)
//   2. CAREER_OPS_ROOT=<root> npx next start --port 3135   (from web/)
//   3. SCAV_E2E_ROOT=<root> node scripts/phase10-http-e2e.mjs
// Live Greenhouse boards-api traffic is used for discovery + one bounded
// verification. CLOSED/BLOCKED are simulated through the same persistence
// path (live pages cannot be relied on for every status). Dice regression is
// proven by running the Phase 9 dice suite as a subprocess step.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = 'C:\\Users\\jerish_j\\career-ops';
const root = process.env.SCAV_E2E_ROOT || mkdtempSync(join(tmpdir(), 'scav-p10e2e-'));
mkdirSync(join(root, 'data', 'scavenger'), { recursive: true });
for (const d of ['lib', 'providers', 'templates']) {
  if (!existsSync(join(root, d))) symlinkSync(join(REPO, d), join(root, d), 'junction');
}
for (const f of ['workspace.json', 'history.json', 'discovery-runs.json', 'job-store.json']) {
  rmSync(join(root, 'data', 'scavenger', f), { force: true });
}
rmSync(join(root, 'data', 'scavenger', 'runs'), { recursive: true, force: true });

const ok = [];
const check = (name, cond, extra = '') => { ok.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const base = 'http://localhost:3135';
const j = (r) => r.json();
const storeFile = join(root, 'data', 'scavenger', 'job-store.json');
const historyFile = join(root, 'data', 'scavenger', 'history.json');

let failed = false;
async function waitReady() {
  for (let i = 0; i < 45; i++) {
    try { const r = await fetch(`${base}/api/sc/profiles`); if (r.ok) return true; } catch { /* warming */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
try {
  check('0. server ready', await waitReady());

  // 1. Discover jobs: one live Greenhouse board fetch → canonical store.
  const gh = (await import(pathToFileURL(join(REPO, 'providers', 'greenhouse.mjs')).href)).default;
  const { fetchJson } = await import(pathToFileURL(join(REPO, 'providers', '_http.mjs')).href);
  const live = await gh.fetch(
    { name: 'Anthropic', api: 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs' },
    { fetchJson: (u, o) => fetchJson(u, o) },
  );
  check('1. live greenhouse board fetched', live.length > 5, `${live.length} postings`);
  const { loadStore, saveStore, upsertJobs } = await import(pathToFileURL(join(REPO, 'lib', 'job-store.mjs')).href);
  const { canonicalJobKey } = await import(pathToFileURL(join(REPO, 'lib', 'job-dedup.mjs')).href);
  const store = loadStore(storeFile);
  const picked = live.slice(0, 2);
  const persisted = upsertJobs(store, picked.map((p) => ({ ...p, source: 'greenhouse' })), Date.now());
  saveStore(store, storeFile);
  check('1. canonical records stored', persisted.added === 2, JSON.stringify(persisted.byId).slice(0, 120));
  const idA = canonicalJobKey({ ...picked[0], source: 'greenhouse' });
  const idB = canonicalJobKey({ ...picked[1], source: 'greenhouse' });

  // Profile for outcome checks.
  const pa = await fetch(`${base}/api/sc/profiles`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Eng A', targetRoles: ['Engineer'], seniority: 'senior', skills: ['Python'] }),
  }).then(j).then((d) => d.profile);
  check('2. profile created', !!pa.id);
  await fetch(`${base}/api/sc/opportunities`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: idA, profileId: pa.id, action: 'save' }),
  }).then(j);

  // 3–4. Bounded live verification of job A.
  const cliOut = execFileSync('node', [join(REPO, 'verify.mjs'), '--dataRoot', root, '--provider', 'greenhouse', '--job', idA],
    { encoding: 'utf8', timeout: 180000 });
  check('3. greenhouse verify ACTIVE', /Verified: 1/.test(cliOut) && /ACTIVE: 1/.test(cliOut),
    cliOut.split('\n').slice(0, 6).join(' | '));
  const recA = JSON.parse(readFileSync(storeFile, 'utf8')).jobs[idA];
  check('4. evidence persisted per-source', recA?.verificationHistory?.length === 1
    && recA?.verificationHistory?.[0]?.evidence?.type === 'api_record_active'
    && recA?.verificationBySource?.greenhouse?.status === 'ACTIVE',
    recA?.verificationHistory?.[0]?.evidence?.type || 'none');
  const detail = await fetch(`${base}/api/sc/opportunities?job=${encodeURIComponent(idA)}&profiles=${pa.id}`).then(j);
  check('4. detail exposes greenhouse verification',
    detail.ok === true && (detail.verification?.sources || []).some((s) => s.provider === 'greenhouse' && s.status === 'ACTIVE'));

  // 5–6. Simulated explicit CLOSED → closure evidence persists.
  const { recordVerification } = await import(pathToFileURL(join(REPO, 'lib', 'liveness-engine.mjs')).href);
  const s2 = loadStore(storeFile);
  const closedRes = recordVerification(s2, idA, {
    provider: 'greenhouse', status: 'CLOSED',
    evidence: {
      type: 'explicit-provider', provider: 'greenhouse', source: picked[0].url,
      observedAt: new Date().toISOString(), confidence: 'high', reason: 'E2E simulated explicit closure',
    },
  }, {});
  saveStore(s2, storeFile);
  const recA2 = JSON.parse(readFileSync(storeFile, 'utf8')).jobs[idA];
  check('5/6. CLOSED persisted', closedRes.closed === true && recA2?.lifecycle === 'closed' && !!recA2?.closedEvidence);

  // 7–8. Simulated BLOCKED on job B: recorded, never closes.
  const s3 = loadStore(storeFile);
  recordVerification(s3, idB, {
    provider: 'greenhouse', status: 'BLOCKED',
    evidence: { type: 'blocked_page', provider: 'greenhouse', observedAt: new Date().toISOString(), confidence: 'high', reason: 'E2E simulated block' },
  }, {});
  saveStore(s3, storeFile);
  const recB = JSON.parse(readFileSync(storeFile, 'utf8')).jobs[idB];
  check('7/8. BLOCKED does not close', recB?.lifecycle === 'active'
    && recB?.verificationBySource?.greenhouse?.status === 'BLOCKED');

  // 9. Canonical ID stability across the whole flow.
  const idA2 = canonicalJobKey({ ...picked[0], source: 'greenhouse' });
  check('9. canonical id stable', idA2 === idA, idA2);

  // 10. Profile outcomes intact.
  const hist = JSON.parse(readFileSync(historyFile, 'utf8'));
  check('10. saved outcome intact', hist.matches?.[`${pa.id}::${idA}`]?.outcome === 'saved');

  // 11. Dice regression: Phase 9 suites stay green.
  const diceOut = execFileSync('node', ['--test', 'tests/verify-dice.test.mjs', 'tests/verify-greenhouse.test.mjs'],
    { encoding: 'utf8', timeout: 300000, cwd: REPO });
  check('11. dice+greenhouse suites green', /pass 28/.test(diceOut) && /fail 0/.test(diceOut),
    diceOut.split('\n').filter((l) => /tests|pass|fail/.test(l)).join(' ').slice(0, 200));
} catch (e) {
  console.log('E2E ERROR', e.message);
  failed = true;
}
if (ok.some((c) => !c)) failed = true;
console.log(failed ? 'E2E FAILED' : 'E2E ALL PASS');
process.exit(failed ? 1 : 0);
