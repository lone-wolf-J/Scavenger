// Phase 11 HTTP E2E — match quality + opportunity UX, production build.
// (run manually, not part of test-all)
//   1. fixture root = full checkout shape (junctions)
//   2. CAREER_OPS_ROOT=<root> npx next start --port 3136   (from web/)
//   3. SCAV_E2E_ROOT=<root> node scripts/phase11-http-e2e.mjs
// Seeds one known evaluation job, matches it under two profiles, exercises
// the detail view, explanation audit, and profile-specific outcomes. The
// match diagnostic itself runs via match-eval.mjs (no network).

import { mkdtempSync, mkdirSync, rmSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = 'C:\\Users\\jerish_j\\career-ops';
const root = process.env.SCAV_E2E_ROOT || mkdtempSync(join(tmpdir(), 'scav-p11e2e-'));
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
const base = 'http://localhost:3136';
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

  // 1. Evaluation profiles A (engineering, full signals) + B (sales).
  const mk = (name, body) => fetch(`${base}/api/sc/profiles`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...body }),
  }).then(j).then((d) => d.profile);
  const pa = await mk('Eval Eng A', {
    targetRoles: ['Senior Backend Engineer'], seniority: 'senior',
    skills: ['Python', 'PostgreSQL', 'Kubernetes'], technologies: ['AWS', 'Docker'],
    domains: ['distributed systems'], functionalAreas: ['engineering'], yearsExperience: 7,
  });
  const pb = await mk('Eval Sales B', { targetRoles: ['Account Executive'], seniority: 'mid', skills: ['Salesforce'] });
  check('1. two evaluation profiles', pa.id && pb.id && pa.id !== pb.id);

  // 2. Known job fixture → canonical store (swe-clear-backend shape).
  const lib = (m) => import(pathToFileURL(join(REPO, 'lib', m)).href);
  const { loadStore, saveStore, upsertJobs } = await lib('job-store.mjs');
  const { canonicalJobKey } = await lib('job-dedup.mjs');
  const knownJob = {
    title: 'Senior Backend Engineer', company: 'Acme Corp', location: 'Austin, TX',
    country: 'US', description: 'Senior backend engineer building distributed systems. Python, PostgreSQL, Kubernetes on AWS. Full-time, remote within the US.',
    url: 'https://example.com/eval/swe-clear-backend', sources: ['eval'],
    employmentType: 'full-time', postedAt: Date.now(), source: 'eval',
  };
  const store = loadStore(storeFile);
  upsertJobs(store, [knownJob], Date.now());
  saveStore(store, storeFile);
  const jobId = canonicalJobKey({ ...knownJob });
  check('2. known job stored', !!JSON.parse(readFileSync(storeFile, 'utf8')).jobs[jobId], jobId);

  // 3. Discovery/matching: feed matches the known job under A.
  const feedA = await fetch(`${base}/api/sc/opportunities?profiles=${pa.id}`).then(j);
  const hitA = (feedA.results || []).find((r) => r.jobId === jobId);
  check('3. job matched under A', !!hitA && hitA.best?.score >= 75, `score=${hitA?.best?.score}`);

  // 4. Match diagnostic via CLI (fixture eval set, no network).
  const cliOut = execFileSync('node', [join(REPO, 'match-eval.mjs'), '--profile', 'eval-software-eng'],
    { encoding: 'utf8', timeout: 120000, cwd: REPO });
  check('4. diagnostic produced', /swe-clear-backend \[CLEAR_MATCH\] score=86 band=strong/.test(cliOut));

  // 5–6. Opportunity detail + explanation audit.
  const detail = await fetch(`${base}/api/sc/opportunities?job=${encodeURIComponent(jobId)}&profiles=${pa.id},${pb.id}`).then(j);
  check('5. detail shows matches + facts', detail.ok === true && detail.matches?.length === 2 && !!detail.job?.title);
  const { auditMatchExplanation } = await lib('explanation-audit.mjs');
  const matchA = detail.matches.find((m) => m.profileId === pa.id);
  const audit = auditMatchExplanation({
    match: matchA,
    job: detail.job,
    profile: {
      targetRoles: ['Senior Backend Engineer'], seniority: 'senior',
      skills: ['Python', 'PostgreSQL', 'Kubernetes'], technologies: ['AWS', 'Docker'],
      domains: ['distributed systems'], functionalAreas: ['engineering'], yearsExperience: 7,
    },
  });
  check('6. explanation audited clean', audit.violations.length === 0, `checked=${audit.checked}`);

  // 7. Save under A.
  const sv = await fetch(`${base}/api/sc/opportunities`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, profileId: pa.id, action: 'save' }),
  }).then(j);
  check('7. saved under A', sv.entry?.outcome === 'saved');

  // 8–9. Same job under B stays independent (B sees it, low score, no outcome).
  const detailB = await fetch(`${base}/api/sc/opportunities?job=${encodeURIComponent(jobId)}&profiles=${pa.id},${pb.id}`).then(j);
  const matchB = detailB.matches.find((m) => m.profileId === pb.id);
  check('8. matched under B independently', !!matchB && matchB.score < (matchA?.score || 0), `B=${matchB?.score} A=${matchA?.score}`);
  check('9. B has no outcome yet', (detailB.history?.[pb.id]?.outcome || 'surfaced') === 'surfaced'
    && detailB.history?.[pa.id]?.outcome === 'saved');

  // 10–11. Reject B; A remains saved.
  await fetch(`${base}/api/sc/opportunities`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, profileId: pb.id, action: 'reject' }),
  }).then(j);
  const hist = JSON.parse(readFileSync(historyFile, 'utf8'));
  check('10. B rejected', hist.matches?.[`${pb.id}::${jobId}`]?.outcome === 'rejected');
  check('11. A still saved', hist.matches?.[`${pa.id}::${jobId}`]?.outcome === 'saved');

  // 12. No duplicate canonical job.
  const ids = Object.keys(JSON.parse(readFileSync(storeFile, 'utf8')).jobs);
  check('12. single canonical record', ids.length === 1, ids.join(','));
} catch (e) {
  console.log('E2E ERROR', e.message);
  failed = true;
}
if (ok.some((c) => !c)) failed = true;
console.log(failed ? 'E2E FAILED' : 'E2E ALL PASS');
process.exit(failed ? 1 : 0);
