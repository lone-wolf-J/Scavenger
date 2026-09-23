// Greenhouse verification tests — classifier branches, verifyJob contract,
// evidence compactness, and source isolation against Dice. Live-trimmed
// fixtures come from real boards-api captures (2026-09-18).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import greenhouse, { detailUrlForJob, classifyGreenhouseDetail } from '../providers/greenhouse.mjs';
import { evaluateVerificationFixtures } from '../lib/verify-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(HERE, 'fixtures', 'greenhouse-verify', n), 'utf8');
const fxJson = (n) => JSON.parse(fx(n));
const URL = 'https://job-boards.greenhouse.io/anthropic/jobs/5421031008';
const API = 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs/5421031008';

describe('greenhouse verifyJob contract', () => {
  it('declares NOT_FOUND unreliable (Phase 10 §6–7: measure first)', () => {
    assert.equal(greenhouse.verify?.reliableAbsence, false);
    assert.equal(typeof greenhouse.verifyJob, 'function');
  });

  it('derives the per-posting API URL or refuses', () => {
    assert.equal(
      detailUrlForJob({ url: 'https://job-boards.greenhouse.io/anthropic/jobs/5421031008?x=1' }),
      API,
    );
    assert.equal(
      detailUrlForJob({ url: 'https://boards.greenhouse.io/anthropic/jobs/5421031008/' }),
      API,
    );
    assert.equal(detailUrlForJob({ url: 'https://job-boards.eu.greenhouse.io/acme/jobs/1' }), null);
    assert.equal(detailUrlForJob({ url: 'https://boards-api.greenhouse.io/v1/boards/a/jobs' }), null);
    assert.equal(detailUrlForJob({ url: 'https://evil.com/anthropic/jobs/1' }), null);
    assert.equal(detailUrlForJob({}), null);
  });
});

describe('greenhouse detail classifier', () => {
  it('ACTIVE on the live-trimmed record', () => {
    const c = classifyGreenhouseDetail({ status: 200, json: fxJson('active.json'), url: API });
    assert.equal(c.status, 'ACTIVE');
    assert.equal(c.evidenceType, 'api_record_active');
    assert.equal(c.confidence, 'high');
    assert.equal(c.jobTitle, 'Accommodations Partner');
  });

  it('NOT_FOUND on HTTP 404 with the live error body', () => {
    const c = classifyGreenhouseDetail({ status: 404, json: fxJson('not-found.json'), url: API });
    assert.equal(c.status, 'NOT_FOUND');
    assert.equal(c.evidenceType, 'not_found_api');
  });

  it('UNKNOWN on record-less 200 bodies — never guessed', () => {
    for (const json of [fxJson('malformed.json'), null, {}, { id: 1 }, { title: 'x' }]) {
      assert.equal(classifyGreenhouseDetail({ status: 200, json, url: API }).status, 'UNKNOWN');
    }
  });

  it('maps HTTP statuses honestly', () => {
    assert.equal(classifyGreenhouseDetail({ status: 403, url: API }).status, 'BLOCKED');
    assert.equal(classifyGreenhouseDetail({ status: 429, url: API }).status, 'RATE_LIMITED');
    assert.equal(classifyGreenhouseDetail({ status: 503, url: API }).status, 'TEMPORARILY_UNAVAILABLE');
    assert.equal(classifyGreenhouseDetail({ status: 301, url: API }).status, 'UNKNOWN');
  });
});

describe('greenhouse verifyJob end to end (mock transport)', () => {
  const job = { jobId: 'k1', url: URL, source: 'greenhouse' };

  it('returns ACTIVE with compact evidence', async () => {
    const json = fxJson('active.json');
    const res = await greenhouse.verifyJob({
      job,
      ctx: { fetchJson: async (u, o) => { assert.equal(u, API); assert.equal(o?.redirect, 'error'); return json; } },
    });
    assert.equal(res.status, 'ACTIVE');
    assert.equal(res.evidence.type, 'api_record_active');
    assert.equal(res.evidence.provider, 'greenhouse');
    assert.equal(res.evidence.source, API);
    assert.ok(JSON.stringify(res.evidence).length < 1000);
  });

  it('returns NOT_FOUND on 404 without fetching anything else', async () => {
    let calls = 0;
    const err = new Error('HTTP 404');
    err.status = 404;
    const res = await greenhouse.verifyJob({ job, ctx: { fetchJson: async () => { calls++; throw err; } } });
    assert.equal(res.status, 'NOT_FOUND');
    assert.equal(calls, 1);
  });

  it('returns UNKNOWN without requesting when the URL is not a posting', async () => {
    let called = 0;
    const res = await greenhouse.verifyJob({
      job: { jobId: 'k', url: 'https://example.com/x' },
      ctx: { fetchJson: async () => { called++; return {}; } },
    });
    assert.equal(res.status, 'UNKNOWN');
    assert.equal(called, 0);
  });

  it('rethrows transport errors so the engine can retry them', async () => {
    await assert.rejects(
      greenhouse.verifyJob({ job, ctx: { fetchJson: async () => { throw new TypeError('socket hang up'); } } }),
      /socket hang up/,
    );
  });
});

describe('greenhouse eval fixtures', () => {
  it('agreement is tracked per fixture without precision claims', () => {
    const bodies = {
      active: fxJson('active.json'),
      'not-found': fxJson('not-found.json'),
      malformed: fxJson('malformed.json'),
    };
    const out = evaluateVerificationFixtures({
      providerId: 'greenhouse',
      classify: ({ status, url }) => classifyGreenhouseDetail({ status, url, json: null }),
      fixtures: [
        { name: 'active', status: 200, url: API, expectedStatus: 'ACTIVE', classification: 'live-trimmed' },
      ],
    });
    // The framework classifies what it is given: with null bodies every 200
    // is UNKNOWN. Per-fixture bodies travel through the rows below.
    assert.equal(out.rows[0].observedStatus, 'UNKNOWN');
    const out2 = evaluateVerificationFixtures({
      providerId: 'greenhouse',
      classify: ({ status, url, html }) => classifyGreenhouseDetail({ status, url, json: html ? JSON.parse(html) : null }),
      fixtures: [
        { name: 'active', status: 200, html: fx('active.json'), url: API, expectedStatus: 'ACTIVE', classification: 'live-trimmed' },
        { name: 'not-found', status: 404, html: fx('not-found.json'), url: API, expectedStatus: 'NOT_FOUND', classification: 'live-trimmed' },
        { name: 'blocked', status: 403, url: API, expectedStatus: 'BLOCKED', classification: 'http-status' },
        { name: 'malformed', status: 200, html: fx('malformed.json'), url: API, expectedStatus: 'UNKNOWN', classification: 'synthetic' },
      ],
    });
    assert.equal(out2.counts.total, 4);
    assert.equal(out2.counts.agree, 4);
    assert.ok(!('precision' in out2));
    assert.equal(out2.sample.sufficient, false);
    assert.ok(bodies.active.id);
  });
});
