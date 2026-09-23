import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverForProfiles } from '../lib/discovery-engine.mjs';
import { normalizeCareerProfile } from '../lib/career-profile.mjs';
import { sanitizeQueryTerm, familyQuery } from '../lib/search-generation.mjs';

const NOW = Date.now();
const DAY = 86_400_000;
const tmpRoot = () => mkdtempSync(join(tmpdir(), 'scav-privacy-'));

// A profile stuffed with PII-like markers: if any of these leak into run
// records or provider logs, the test catches it. (Skills/job titles may
// legitimately appear inside *query strings* — those are operational search
// terms, not resume text. The invariant bans: emails, phones, resume blobs,
// profile objects, match history, outcomes.)
const MARKERS = {
  email: 'jane.doe.priv@example.com',
  phone: '+1-512-555-0199',
  resumeBlob: 'PRIV-RESUME-BLOB-UNIQUE-STRING',
};
const PII_PROFILE = normalizeCareerProfile({
  targetRoles: ['HR Director'],
  seniority: 'director',
  skills: [`Workday ${MARKERS.email}`, MARKERS.phone],
  technologies: [],
});

describe('privacy boundaries (§19)', () => {
  it('run records + provider logs carry ids/counts, never resume/PII text', async () => {
    const root = tmpRoot();
    const mods = new Map([['dice', {
      id: 'dice', detect: () => null,
      async fetch() {
        return [{ title: 'HR Director', company: 'Acme', location: 'Chicago, IL', url: 'https://j/1', postedAt: NOW - DAY, description: 'HR' }];
      },
    }]]);
    const r = await discoverForProfiles({
      profiles: [{ id: 'hr', profile: PII_PROFILE }],
      providers: ['dice'], providerModules: mods,
      dataRoot: root, jobStorePath: join(root, 's.json'), runsPath: join(root, 'r.json'),
      now: NOW, maxQueries: 1,
    });
    assert.equal(r.status, 'COMPLETE');
    const runsBlob = readFileSync(join(root, 'r.json'), 'utf8');
    assert.ok(!runsBlob.includes(MARKERS.email), 'email leaked into run record');
    assert.ok(!runsBlob.includes(MARKERS.phone), 'phone leaked into run record');
    assert.ok(!runsBlob.includes(MARKERS.resumeBlob), 'resume text leaked into run record');
    assert.ok(!runsBlob.includes('matchedSignals'), 'match state leaked into run record');
    // Error/log strings likewise.
    for (const e of r.errors) {
      const s = JSON.stringify(e);
      assert.ok(!s.includes(MARKERS.email) && !s.includes(MARKERS.resumeBlob));
    }
    // Provider log entries carry provider + errorType only.
    const logged = JSON.parse(runsBlob).runs[0];
    assert.ok(Array.isArray(logged.queries));
    assert.ok(!('profiles' in logged) || !JSON.stringify(logged).includes('Workday ' + MARKERS.email.slice(0, 4)));
  });

  it('match history entries never enter the provider cache', async () => {
    const { recordSuccess, loadCache } = await import('../lib/provider-cache.mjs');
    const root = tmpRoot();
    recordSuccess(root, 'dice', {
      jobIds: ['https://j/1'], jobCount: 1,
      jobsSnapshot: [{ title: 'T', url: 'https://j/1', source: 'dice' }],
    });
    const blob = JSON.stringify(loadCache(root, 'dice'));
    for (const k of ['matchedSignals', 'outcome', 'profileId', 'userId', 'reasons']) {
      assert.ok(!blob.includes(`"${k}"`), `history key in cache: ${k}`);
    }
  });
});

describe('query sanitization (§19)', () => {
  it('strips emails/phones from generated queries, keeps searchable terms', () => {
    assert.equal(sanitizeQueryTerm('Workday jane@example.com'), 'Workday');
    assert.equal(sanitizeQueryTerm('+1-512-555-0199'), '');
    assert.equal(sanitizeQueryTerm('HR Director'), 'HR Director');
    const q = familyQuery({ positives: ['HR Director'], boosters: ['Workday x@y.zz', '+1-512-555-0100'] }, { withBoosters: 2 });
    assert.ok(!q.includes('@') && !q.includes('512'));
    assert.ok(q.includes('HR Director') && q.includes('Workday'));
  });
});
