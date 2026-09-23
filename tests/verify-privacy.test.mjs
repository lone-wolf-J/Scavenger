// Verification privacy tests — verification logs and provider cache must
// never carry resume text, profile objects, or personal information.
// Verification touches ONE public posting URL per job and stores compact,
// pre-declared evidence fields only.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dice from '../providers/dice.mjs';
import { verifyExistingJobs } from '../lib/verify-service.mjs';
import { recordVerification } from '../lib/liveness-engine.mjs';

const PII_JOB = {
  jobId: 'k-pii',
  title: 'Engineer',
  company: 'Acme',
  url: 'https://www.dice.com/job-detail/abc-123',
  source: 'dice',
  sources: ['dice'],
  description: 'My resume: john.doe@example.com, 555-0100, SSN 123-45-6789. I worked at Initech.',
};

describe('verification privacy', () => {
  it('dice evidence carries no description, resume, or profile text', async () => {
    const html = '<html><head><title>Engineer - Acme - Austin, TX | Dice.com</title></head><body>Apply Now</body></html>';
    const res = await dice.verifyJob({ job: PII_JOB, ctx: { fetchText: async () => html } });
    const blob = JSON.stringify(res.evidence);
    assert.ok(!blob.includes('john.doe@example.com'));
    assert.ok(!blob.includes('555-0100'));
    assert.ok(!blob.includes('Initech'));
    assert.ok(!blob.includes('<html'));
  });

  it('verifyJob fetches exactly one URL: the job detail page', async () => {
    const seen = [];
    await dice.verifyJob({ job: PII_JOB, ctx: { fetchText: async (u) => { seen.push(u); return '<html><head><title>t | Dice.com</title></head><body></body></html>'; } } });
    assert.deepEqual(seen, ['https://www.dice.com/job-detail/abc-123']);
  });

  it('persisted verification records contain only verification fields', async () => {
    const mods = new Map([['dice', dice]]);
    const store = { version: 1, jobs: { 'k-pii': { ...PII_JOB } } };
    const histories = { matches: { 'p1::k-pii': { jobId: 'k-pii', profileId: 'p1', score: 90, outcome: 'saved', profile: { name: 'Secret', targetRoles: ['x'] } } } };
    const out = await verifyExistingJobs({
      store, histories, providerModules: mods,
      ctx: { fetchText: async () => { throw new Error('HTTP 403'); } },
      jobId: 'k-pii', dryRun: false,
    });
    const after = store.jobs['k-pii'];
    const added = Object.keys(after).filter((k) => !(k in PII_JOB));
    assert.deepEqual(added.sort(), ['lastVerifiedAt', 'verificationBySource', 'verificationHistory']);
    assert.ok(!JSON.stringify(after.verificationHistory).includes('Secret'));
    assert.equal(out.results[0].status, 'ERROR'); // transport throw → engine ERROR, recorded not closed
    assert.equal(after.lifecycle, undefined); // lifecycle untouched by failure
  });

  it('verification never writes to the provider cache (structural)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../lib/verify-service.mjs', import.meta.url), 'utf8');
    assert.ok(!src.includes('provider-cache'), 'verify-service must not touch the provider cache');
    assert.ok(!src.includes('recordSuccess') && !src.includes('saveCache'));
    const diceSrc = readFileSync(new URL('../providers/dice.mjs', import.meta.url), 'utf8');
    assert.ok(!diceSrc.includes('recordSuccess') && !diceSrc.includes('saveCache'));
  });

  it('recordVerification stores evidence keys only (allowlist)', () => {
    const store = { version: 1, jobs: { k: { jobId: 'k' } } };
    recordVerification(store, 'k', {
      provider: 'dice', status: 'ACTIVE',
      evidence: { type: 't', provider: 'dice', source: 's', observedAt: 'o', confidence: 'high', reason: 'r', resume: 'DROP', profile: { name: 'DROP' } },
    }, {});
    assert.deepEqual(Object.keys(store.jobs.k.verificationHistory[0].evidence).sort(),
      ['confidence', 'observedAt', 'provider', 'reason', 'source', 'type']);
  });
});
