// Phase 9 HTTP E2E (run manually, not part of test-all).
// Isolated production-build verification of the §23 acceptance flow:
//   1. fixture root = full checkout shape (junctions, like the Phase 8 root)
//   2. CAREER_OPS_ROOT=<root> npx next start --port 3134   (from web/)
//   3. SCAV_E2E_ROOT=<root> node scripts/phase9-http-e2e.mjs
// Live Dice traffic is used ONLY for discovery + one bounded verification
// (steps 2–6). CLOSED/BLOCKED are simulated through the same persistence
// path the service uses (recordVerification), because live pages cannot be
// relied on to produce every status; the status-classification matrix itself
// is covered by tests/verify-dice.test.mjs fixtures. The fixture store is
// wiped at start for determinism (discovery rebuilds it). No profile or
// resume data exists in this fixture at any point.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'C:\\Users\\jerish_j\\career-ops';
const root = process.env.SCAV_E2E_ROOT || mkdtempSync(join(tmpdir(), 'scav-p9e2e-'));
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
const base = 'http://localhost:3134';
const j = (r) => r.json();
const storeFile = join(root, 'data', 'scavenger', 'job-store.json');
const historyFile = join(root, 'data', 'scavenger', 'history.json');
const readStore = () => JSON.parse(readFileSync(storeFile, 'utf8'));
const readHistory = () => JSON.parse(readFileSync(historyFile, 'utf8'));

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
  // 1. Two profiles via API.
  const mk = (name, roles) => fetch(`${base}/api/sc/profiles`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, targetRoles: roles, seniority: 'senior', skills: ['Python'] }),
  }).then(j).then((d) => d.profile);
  const pa = await mk('Eng A', ['Senior Engineer']);
  const pb = await mk('Eng B', ['Designer']);
  check('1. two profiles', pa.id && pb.id && pa.id !== pb.id);

  // 2. Discover (real Dice, bounded).
  const started = await fetch(`${base}/api/sc/opportunities/discover`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: [pa.id, pb.id], providers: ['dice'], maxQueries: 1 }),
  }).then(j);
  check('2. discover queued', started.runId && started.status === 'QUEUED');
  let run = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await fetch(`${base}/api/sc/opportunities/discover/${started.runId}`).then(j);
    if (s.run && !['QUEUED', 'RUNNING'].includes(s.run.status)) { run = s.run; break; }
  }
  check('2. discover terminal', run && ['COMPLETE', 'PARTIAL'].includes(run.status), run?.status);

  // 3. Select one canonical job with a Dice source (+ a second for BLOCKED).
  const feed = await fetch(`${base}/api/sc/opportunities?profiles=${pa.id},${pb.id}`).then(j);
  const diceJobs = (feed.results || []).filter((r) => (r.job?.sources || []).includes('dice') && r.job);
  check('3. dice jobs discovered', diceJobs.length >= 2, String(diceJobs.length));
  const jobA = diceJobs[0];
  const jobB = diceJobs[1];
  const idA0 = jobA.jobId;

  // Save A first so step 9 can prove outcomes survive lifecycle changes.
  await fetch(`${base}/api/sc/opportunities`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: jobA.jobId, profileId: pa.id, action: 'save', discoveryRunId: run?.runId || started.runId }),
  }).then(j);

  // 4–6. Real bounded Dice verification via the CLI against the fixture root.
  const cliOut = execFileSync('node', [join(REPO, 'verify.mjs'), '--dataRoot', root, '--provider', 'dice', '--job', jobA.jobId],
    { encoding: 'utf8', timeout: 180000 });
  check('4. verify CLI ran', /Verified: 1/.test(cliOut), cliOut.split('\n').slice(0, 8).join(' | '));
  const recA = readStore().jobs[jobA.jobId];
  check('5. verification evidence persisted', recA?.verificationHistory?.length === 1 && !!recA?.verificationHistory?.[0]?.evidence?.type,
    recA?.verificationHistory?.[0]?.evidence?.type || 'none');
  check('5. per-source map written', recA?.verificationBySource?.dice?.status === recA?.verificationHistory?.[0]?.status);
  check('6. lifecycle stays active after verify', recA?.lifecycle === 'active', recA?.lifecycle);
  // Detail + feed expose verification without raw bodies.
  const detail = await fetch(`${base}/api/sc/opportunities?job=${encodeURIComponent(jobA.jobId)}&profiles=${pa.id}`).then(j);
  check('6. detail verification block', detail.ok === true && Array.isArray(detail.verification?.sources)
    && !JSON.stringify(detail.verification).includes('<div'), `sources=${detail.verification?.sources?.length || 0}`);

  // 7–9. Simulate explicit CLOSED evidence through the persistence path.
  const { pathToFileURL } = await import('node:url');
  const { recordVerification } = await import(pathToFileURL(join(REPO, 'lib', 'liveness-engine.mjs')).href);
  const { loadStore, saveStore } = await import(pathToFileURL(join(REPO, 'lib', 'job-store.mjs')).href);
  const store = loadStore(storeFile);
  const closedRes = recordVerification(store, jobA.jobId, {
    provider: 'dice',
    status: 'CLOSED',
    evidence: {
      type: 'explicit-provider', provider: 'dice', source: jobA.job?.url || jobA.jobId,
      observedAt: new Date().toISOString(), confidence: 'high', reason: 'E2E simulated explicit closure',
    },
  }, {});
  saveStore(store, storeFile);
  check('7. explicit CLOSED applied', closedRes.applied === true && closedRes.closed === true);
  const recA2 = readStore().jobs[jobA.jobId];
  check('8. job is CLOSED', recA2?.lifecycle === 'closed');
  const hist = readHistory();
  const savedEntry = hist.matches?.[`${pa.id}::${jobA.jobId}`];
  check('9. saved outcome survives closure', savedEntry?.outcome === 'saved', savedEntry?.outcome);
  check('9. discoveryRunId propagated', savedEntry?.discoveryRunId === (run?.runId || started.runId), savedEntry?.discoveryRunId || 'missing');

  // 10–11. Simulate BLOCKED on job B: recorded, never closes.
  const storeB = loadStore(storeFile);
  recordVerification(storeB, jobB.jobId, {
    provider: 'dice', status: 'BLOCKED',
    evidence: { type: 'blocked_page', provider: 'dice', observedAt: new Date().toISOString(), confidence: 'high', reason: 'E2E simulated block' },
  }, {});
  saveStore(storeB, storeFile);
  const recB = readStore().jobs[jobB.jobId];
  check('10/11. BLOCKED recorded without closure', recB?.lifecycle === 'active'
    && recB?.verificationBySource?.dice?.status === 'BLOCKED', recB?.lifecycle);

  // 12–15. Second discovery; history, identity, and matches intact.
  const started2 = await fetch(`${base}/api/sc/opportunities/discover`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: [pa.id, pb.id], providers: ['dice'], maxQueries: 1 }),
  }).then(j);
  let run2 = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await fetch(`${base}/api/sc/opportunities/discover/${started2.runId}`).then(j);
    if (s.run && !['QUEUED', 'RUNNING'].includes(s.run.status)) { run2 = s.run; break; }
  }
  check('12. second discovery terminal', run2 && ['COMPLETE', 'PARTIAL'].includes(run2.status), run2?.status);
  const recA3 = readStore().jobs[jobA.jobId];
  check('13. verification history survives rediscovery', (recA3?.verificationHistory || []).length >= 2
    && !!recA3?.closedEvidence, `entries=${recA3?.verificationHistory?.length || 0}`);
  check('14. canonical id stable', !!recA3 && jobA.jobId === idA0);
  const hist2 = readHistory();
  const survivors = Object.values(hist2.matches || {}).filter((e) => e.jobId === jobA.jobId);
  check('15. profile matches intact', survivors.length >= 1 && survivors.some((e) => e.profileId === pa.id && e.outcome === 'saved'));
} catch (e) {
  console.log('E2E ERROR', e.message);
  failed = true;
}
if (ok.some((c) => !c)) failed = true;
console.log(failed ? 'E2E FAILED' : 'E2E ALL PASS');
process.exit(failed ? 1 : 0);
