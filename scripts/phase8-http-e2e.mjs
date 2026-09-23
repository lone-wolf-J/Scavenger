// Phase 8 HTTP E2E (run manually, not part of test-all).
// Seeds an isolated CAREER_OPS_ROOT fixture (fixture root = full checkout
// shape: junction or copy lib/, providers/, templates/ next to data/), then
// exercises the production server and asserts feed behavior end to end:
//   1. node scripts/phase7-http-fixture.mjs <root>   (or hand-build per below)
//   2. CAREER_OPS_ROOT=<root> npx next start --port 3133   (from web/)
//   3. SCAV_E2E_ROOT=<root> node scripts/phase8-http-e2e.mjs
// The seed deliberately uses STALE stored ids (date part differs from the
// recomputed canonical key) to lock the dual-key join in getOpportunities /
// getJobDetail: stored keys stay stable across refinements while aggregation
// remaps to recomputed canonical keys.
// NOTE: the async-discover step runs a REAL provider fetch (dice) and merges
// results into the fixture store; re-running reseeds the store but appends
// history. For a pristine run, wipe <root>/data/scavenger minus the seed.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.env.SCAV_E2E_ROOT || mkdtempSync(join(tmpdir(), 'scav-httpe2e-'));
mkdirSync(join(root, 'data', 'scavenger'), { recursive: true });
// Deterministic fixture: wipe profiles/history/runs so retrieval-once state
// from a previous run cannot leak into this one; the store is re-seeded below.
for (const f of ['workspace.json', 'history.json']) {
  rmSync(join(root, 'data', 'scavenger', f), { force: true });
}
rmSync(join(root, 'data', 'scavenger', 'runs'), { recursive: true, force: true });
const NOW = Date.now();
const DAY = 86_400_000;
const ok = [];
const check = (name, cond, extra = '') => { ok.push([name, !!cond]); console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

const J1 = 'key:acme::senior engineer::tx::2026-01-15';
const J2 = 'key:beta::designer::tx::2026-01-10';
const J3 = 'key:gamma::analyst::tx::2026-01-05';
const rec = (id, o) => ({
  jobId: id, canonicalKey: id, title: o.title, company: o.company, location: 'Austin, TX',
  url: o.url, applyUrl: o.url, source: 'dice', sourceJobId: '', sources: ['dice'],
  postedAt: o.postedAt, discoveredAt: NOW - 3 * DAY, firstSeen: o.firstSeen, lastSeen: o.lastSeen,
  seenCount: 2, salary: null, description: `${o.title} work`, descriptionHash: 'h',
  lifecycle: o.lifecycle, lifecycleAt: new Date(NOW - DAY).toISOString(),
  lastChangedAt: o.changed ? new Date(NOW - DAY).toISOString() : null,
  lastChangedFields: o.changed ? ['salary'] : [],
  ...(o.closedEvidence ? { closedEvidence: o.closedEvidence } : {}),
});
writeFileSync(join(root, 'data', 'scavenger', 'job-store.json'), JSON.stringify({ version: 1, jobs: {
  [J1]: rec(J1, { title: 'Senior Engineer', company: 'Acme', url: 'https://j/1', postedAt: NOW - DAY, firstSeen: NOW - DAY, lastSeen: NOW - DAY, lifecycle: 'active' }),
  [J2]: rec(J2, { title: 'Designer', company: 'Beta', url: 'https://j/2', postedAt: NOW - 2 * DAY, firstSeen: NOW - 2 * DAY, lastSeen: NOW - 2 * DAY, lifecycle: 'active' }),
  [J3]: rec(J3, { title: 'Analyst', company: 'Gamma', url: 'https://j/3', postedAt: NOW - 40 * DAY, firstSeen: NOW - 40 * DAY, lastSeen: NOW - 40 * DAY, lifecycle: 'closed', closedEvidence: { type: 'manual', confidence: 'high', reason: 'user confirmed', observedAt: new Date(NOW - 10 * DAY).toISOString() } }),
} }));

const server = null; // managed externally: start prod server with CAREER_OPS_ROOT set, port 3133.
const base = 'http://localhost:3133';
async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/api/sc/profiles`); if (r.ok) return true; } catch { /* warming */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
const j = async (r) => r.json();
let failed = false;
try {
  check('server ready', await waitReady());
  // Create two profiles via API.
  const mk = (name, roles) => fetch(`${base}/api/sc/profiles`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, targetRoles: roles, seniority: 'senior', skills: ['Python'] }),
  }).then(j).then((d) => d.profile);
  const pa = await mk('Eng A', ['Senior Engineer']);
  const pb = await mk('Eng B', ['Designer']);
  check('profiles created', pa.id && pb.id, pa.id);
  // Feed default hides closed (records nest under `job`; aggregated jobIds
  // are recomputed canonical keys which may differ from stale stored ids).
  const defaultFeed = await fetch(`${base}/api/sc/opportunities?profiles=${pa.id},${pb.id}`).then(j);
  const cos = (defaultFeed.results || []).map((r) => r.job?.company);
  check('feed default hides closed', !cos.includes('Gamma') && cos.includes('Acme'), cos.join(','));
  check('feed joins records', (defaultFeed.results || []).every((r) => r.job && r.intel), '');
  // Lifecycle filter reaches closed.
  const closedFeed = await fetch(`${base}/api/sc/opportunities?profiles=${pa.id}&lifecycle=closed`).then(j);
  check('lifecycle=closed', closedFeed.results.length === 1 && closedFeed.results[0].job?.company === 'Gamma',
    (closedFeed.results || []).map((r) => `${r.job?.company}|${r.job?.lifecycle}`).join(','));
  // Detail resolves by canonical id even when the stored id is stale.
  const acmeId = (defaultFeed.results || []).find((r) => r.job?.company === 'Acme')?.jobId;
  check('acme in feed', !!acmeId, acmeId || 'missing');
  const detailRes = await fetch(`${base}/api/sc/opportunities?job=${encodeURIComponent(acmeId)}&profiles=${pa.id}`);
  const detailJson = await detailRes.json();
  check('detail resolves', detailJson.ok === true && detailJson.job?.company === 'Acme', String(detailRes.status));
  const sv = await fetch(`${base}/api/sc/opportunities`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: acmeId, profileId: pa.id, action: 'save' }),
  }).then(j);
  check('save ok', sv.ok !== false && sv.entry?.outcome === 'saved');
  const saved = await fetch(`${base}/api/sc/saved`).then(j);
  check('saved lists entry', (saved.saved || []).some((e) => e.jobId === acmeId && e.outcome === 'saved'));
  // Async discover: returns fast with QUEUED (proves no request hold).
  const t0 = Date.now();
  const started = await fetch(`${base}/api/sc/opportunities/discover`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: [pa.id], providers: ['dice'], maxQueries: 1 }),
  }).then(j);
  const dt = Date.now() - t0;
  check('async POST fast', dt < 8000, `${dt}ms`);
  check('queued run', started.runId && started.status === 'QUEUED', started.runId);
  // Duplicate protection: same params → same run.
  const dup = await fetch(`${base}/api/sc/opportunities/discover`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: [pa.id], providers: ['dice'], maxQueries: 1 }),
  }).then(j);
  check('duplicate deduped', dup.runId === started.runId && dup.deduped === true);
  // Poll status (worker may complete or still run; either is structural).
  let st = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    st = await fetch(`${base}/api/sc/opportunities/discover/${started.runId}`).then(j);
    if (st.run && !['QUEUED', 'RUNNING'].includes(st.run.status)) break;
  }
  check('run terminal', st.run && ['COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(st.run.status), st.run?.status);
  // Cancel a terminal run → 409 (transitions enforced).
  const cx = await fetch(`${base}/api/sc/opportunities/discover/${started.runId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }),
  });
  check('cancel terminal rejected', cx.status === 409);
  // Run history lists it.
  const hist = await fetch(`${base}/api/sc/opportunities/discover`).then(j);
  check('run history', (hist.asyncRuns || []).some((r) => r.runId === started.runId));
} catch (e) {
  console.log('E2E ERROR', e.message);
  failed = true;
} finally {
  // External server left running for inspection; stop it manually.
}
if (ok.some(([, c]) => !c)) failed = true;
console.log(failed ? 'E2E FAILED' : 'E2E ALL PASS');
process.exit(failed ? 1 : 0);
