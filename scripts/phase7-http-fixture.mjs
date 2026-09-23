// Phase 7 HTTP E2E fixture builder (run manually, not part of test-all).
// Usage: node scripts/phase7-http-fixture.mjs <outDir>
import { mkdirSync, writeFileSync, cpSync, readdirSync } from 'fs';
import { join } from 'path';

const out = process.argv[2];
if (!out) throw new Error('outDir required');
const NOW = Date.now();
const DAY = 86_400_000;

cpSync('lib', join(out, 'lib'), { recursive: true });
// discovery-engine.mjs statically imports ../providers/_registry.mjs, so a
// runnable fixture root needs the provider tree too (no network is touched
// unless a discover POST runs provider fetches).
cpSync('providers', join(out, 'providers'), { recursive: true });
// Root-level .mjs siblings imported by the provider tree (user-agent.mjs,
// tracker-*.mjs, …). Copied, never executed by the fixture itself.
for (const f of readdirSync('.')) {
  if (f.endsWith('.mjs')) cpSync(f, join(out, f));
}
mkdirSync(join(out, 'data', 'scavenger'), { recursive: true });

const jobs = {
  // canonical keys: key:<company>::<title>::<area>::<date>
  'key:acme::hr director::il::2026-08-01': {
    jobId: 'key:acme::hr director::il::2026-08-01', canonicalKey: 'key:acme::hr director::il::2026-08-01',
    title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://j/x',
    applyUrl: 'https://j/x', source: 'dice', sourceJobId: '', sources: ['dice', 'linkedin'],
    postedAt: Date.parse('2026-08-01'), discoveredAt: NOW - 2 * DAY,
    firstSeen: NOW - 2 * DAY, lastSeen: NOW - DAY, seenCount: 3,
    salary: { min: 170000, currency: 'USD' }, description: 'talent acquisition, Workday',
    descriptionHash: 'x', lifecycle: 'active', lifecycleAt: new Date(NOW - DAY).toISOString(),
    lastChangedAt: new Date(NOW - DAY).toISOString(), lastChangedFields: ['salary'],
  },
  'key:beta::hr manager::tx::2026-07-01': {
    jobId: 'key:beta::hr manager::tx::2026-07-01', canonicalKey: 'key:beta::hr manager::tx::2026-07-01',
    title: 'HR Manager', company: 'Beta', location: 'Austin, TX', url: 'https://j/y',
    applyUrl: 'https://j/y', source: 'dice', sourceJobId: '', sources: ['dice'],
    postedAt: Date.parse('2026-07-01'), discoveredAt: NOW - 40 * DAY,
    firstSeen: NOW - 40 * DAY, lastSeen: NOW - 40 * DAY, seenCount: 1,
    salary: null, description: 'HR operations', descriptionHash: 'y',
    lifecycle: 'closed', lifecycleAt: new Date(NOW - 10 * DAY).toISOString(),
    lastChangedAt: null, lastChangedFields: [],
    closedEvidence: { type: 'explicit-provider', provider: 'dice', confidence: 'high', reason: 'detail 404', observedAt: new Date(NOW - 10 * DAY).toISOString() },
  },
};
writeFileSync(join(out, 'data', 'scavenger', 'job-store.json'), JSON.stringify({ version: 1, jobs }, null, 2));

const match = (jobId, profileId, score, band, outcome) => ({
  userId: 'local', jobId, profileId, score, band, scoringVersion: '1.0', firstScoredVersion: '1.0',
  reasons: ['r'], penalties: [], matchedSignals: [], missingSignals: [],
  jobHash: 'h', profileHash: 'p', scoreChanged: false, jobChanged: false, profileChanged: false,
  viewed: true, viewedAt: new Date(NOW - DAY).toISOString(),
  firstViewedAt: new Date(NOW - DAY).toISOString(), firstSavedAt: null,
  appliedAt: null, interviewAt: null, offerAt: null, hiredAt: null, rejectedAt: null,
  outcome, outcomeAt: new Date(NOW - DAY).toISOString(),
  createdAt: new Date(NOW - 2 * DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(),
});
const xid = 'key:acme::hr director::il::2026-08-01';
const yid = 'key:beta::hr manager::tx::2026-07-01';
const savedEntry = match(xid, 'hr', 90, 'strong', 'saved');
savedEntry.firstSavedAt = new Date(NOW - DAY).toISOString();
const history = { version: 1, matches: { [`hr::${xid}`]: savedEntry, [`swe::${xid}`]: match(xid, 'swe', 45, 'weak', 'rejected') } };
history.matches[`swe::${xid}`].rejectedAt = new Date(NOW - DAY).toISOString();
history.matches[`hr::${yid}`] = match(yid, 'hr', 70, 'review', 'saved');
history.matches[`hr::${yid}`].firstSavedAt = new Date(NOW - 20 * DAY).toISOString();
writeFileSync(join(out, 'data', 'scavenger', 'history.json'), JSON.stringify(history, null, 2));

const profile = (id, name, roles) => ({
  id, name, userId: 'local', state: 'active', signalsHash: 'x', sourceDocumentIds: [],
  createdAt: new Date(NOW - 5 * DAY).toISOString(), updatedAt: new Date(NOW - 5 * DAY).toISOString(),
  confirmedAt: new Date(NOW - 5 * DAY).toISOString(),
  profile: {
    targetRoles: roles, currentRoles: [], seniority: 'director', skills: ['Workday'],
    technologies: [], domains: [], industries: [], functionalAreas: [], leadershipSignals: [],
    yearsExperience: 9, locationPrefs: {}, workplacePrefs: [], employmentPrefs: [],
    compensationPrefs: {}, exclusions: [], searchTerms: roles, semanticSignals: [], profileConfidence: 0.8,
  },
});
writeFileSync(join(out, 'data', 'scavenger', 'workspace.json'), JSON.stringify({
  version: 1, userId: 'local', documents: [], drafts: {},
  profiles: [profile('hr', 'HR Leadership', ['HR Director']), profile('swe', 'Engineering', ['Software Engineer'])],
  selectedProfileIds: ['hr', 'swe'],
}, null, 2));

writeFileSync(join(out, 'data', 'scavenger', 'discovery-runs.json'), JSON.stringify({
  runs: [{
    runId: 'run_seed', createdAt: new Date(NOW - 2 * DAY).toISOString(),
    completedAt: new Date(NOW - 2 * DAY).toISOString(), durationMs: 1200, status: 'COMPLETE',
    userId: 'local', selectedProfileIds: ['hr', 'swe'], queries: ['q1'],
    providersRequested: ['dice'], providersExecuted: ['dice'],
    providerHealth: { dice: 'ACTIVE' }, rawCounts: { dice: 5 }, usAcceptedCounts: { dice: 3 },
    freshCounts: { dice: 3 }, duplicateCounts: { dice: 0 },
    canonicalAdded: 2, canonicalUpdated: 0, unchangedJobs: 0, changedJobIds: [],
    observedJobIds: [xid, yid], missingJobIds: [],
    matchesByProfile: { hr: { matched: 2, highMatch: 1, avgScore: 80 } },
    errors: [], cache: { hits: 0, misses: 1 },
  }],
}, null, 2));
console.log('fixture root ready: ' + out);
