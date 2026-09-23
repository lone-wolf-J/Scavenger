// Dice verification tests — classifier branches, verifyJob contract honesty,
// evidence compactness, and the precision-eval framework. Live-trimmed
// fixtures come from real captures (2026-09-18); synthetic ones are labeled
// and cover branches no live page has shown (expired/closed, challenge).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dice, {
  parseDiceHtml,
  detailUrlForJob,
  classifyDiceDetailPage,
} from '../providers/dice.mjs';
import { evaluateVerificationFixtures } from '../lib/verify-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(HERE, 'fixtures', 'dice-verify', n), 'utf8');
const URL = 'https://www.dice.com/job-detail/abc-123';

describe('dice verifyJob contract', () => {
  it('declares NOT_FOUND unreliable (Phase 9 §4)', () => {
    assert.equal(dice.verify?.reliableAbsence, false);
    assert.equal(typeof dice.verifyJob, 'function');
  });

  it('derives an on-host detail URL or refuses', () => {
    assert.equal(detailUrlForJob({ url: 'https://www.dice.com/job-detail/abc-123?x=1' }), 'https://www.dice.com/job-detail/abc-123');
    assert.equal(detailUrlForJob({ url: 'https://dice.com/job-detail/ABC-9/' }), 'https://www.dice.com/job-detail/ABC-9');
    assert.equal(detailUrlForJob({ url: 'https://www.dice.com/jobs?q=x' }), null);
    assert.equal(detailUrlForJob({ url: 'https://evil.com/job-detail/abc' }), null);
    assert.equal(detailUrlForJob({ url: 'not a url' }), null);
    assert.equal(detailUrlForJob({}), null);
  });
});

describe('dice detail classifier', () => {
  it('ACTIVE on the live-trimmed detail page', () => {
    const c = classifyDiceDetailPage({ status: 200, html: fx('active.html'), url: URL });
    assert.equal(c.status, 'ACTIVE');
    assert.equal(c.evidenceType, 'detail_page_active');
    assert.equal(c.confidence, 'high');
    assert.match(c.pageTitle || '', /Dice\.com/);
  });

  it('NOT_FOUND on the live-trimmed soft-404 page (HTTP 200)', () => {
    const c = classifyDiceDetailPage({ status: 200, html: fx('not-found.html'), url: URL });
    assert.equal(c.status, 'NOT_FOUND');
    assert.equal(c.evidenceType, 'not_found_page');
  });

  it('CLOSED on explicit closure markers (synthetic branch)', () => {
    const c = classifyDiceDetailPage({ status: 200, html: fx('closed-synthetic.html'), url: URL });
    assert.equal(c.status, 'CLOSED');
    assert.equal(c.evidenceType, 'explicit_closed_marker');
  });

  it('BLOCKED on challenge markers (synthetic branch)', () => {
    const c = classifyDiceDetailPage({ status: 200, html: fx('blocked-synthetic.html'), url: URL });
    assert.equal(c.status, 'BLOCKED');
    assert.equal(c.evidenceType, 'blocked_page');
  });

  it('UNKNOWN on malformed pages — never guessed', () => {
    for (const html of [fx('malformed.html'), '', '<html></html>']) {
      assert.equal(classifyDiceDetailPage({ status: 200, html, url: URL }).status, 'UNKNOWN');
    }
  });

  it('ignores React flight noise ("forbidden":"$undefined")', () => {
    const html = '<html><head><title>Engineer - Acme - Austin, TX | Dice.com</title></head><body>Apply Now ["$","$Le",null,{}] "forbidden":"$undefined"</body></html>';
    assert.equal(classifyDiceDetailPage({ status: 200, html, url: URL }).status, 'ACTIVE');
  });

  it('maps HTTP statuses honestly', () => {
    assert.equal(classifyDiceDetailPage({ status: 404, html: '', url: URL }).status, 'NOT_FOUND');
    assert.equal(classifyDiceDetailPage({ status: 403, html: '', url: URL }).status, 'BLOCKED');
    assert.equal(classifyDiceDetailPage({ status: 429, html: '', url: URL }).status, 'RATE_LIMITED');
    assert.equal(classifyDiceDetailPage({ status: 503, html: '', url: URL }).status, 'TEMPORARILY_UNAVAILABLE');
    assert.equal(classifyDiceDetailPage({ status: 301, html: '', url: URL }).status, 'UNKNOWN');
  });
});

describe('dice verifyJob end to end (mock transport)', () => {
  const job = { jobId: 'k1', url: 'https://www.dice.com/job-detail/abc-123', source: 'dice' };

  it('returns ACTIVE with compact evidence, no HTML stored', async () => {
    const html = fx('active.html');
    const res = await dice.verifyJob({ job, ctx: { fetchText: async (u) => { assert.equal(u, URL); return html; } } });
    assert.equal(res.status, 'ACTIVE');
    assert.equal(res.evidence.type, 'detail_page_active');
    assert.equal(res.evidence.provider, 'dice');
    assert.equal(res.evidence.source, URL);
    assert.ok(res.evidence.observedAt);
    for (const v of Object.values(res.evidence)) {
      assert.ok(!String(v).includes('<div'), 'evidence must not contain HTML');
    }
    assert.ok(JSON.stringify(res.evidence).length < 1000, 'evidence stays compact');
  });

  it('returns NOT_FOUND for the soft-404 page', async () => {
    const res = await dice.verifyJob({ job, ctx: { fetchText: async () => fx('not-found.html') } });
    assert.equal(res.status, 'NOT_FOUND');
    assert.equal(res.evidence.type, 'not_found_page');
  });

  it('returns UNKNOWN when the job has no detail URL', async () => {
    let called = 0;
    const res = await dice.verifyJob({ job: { jobId: 'k', url: 'https://example.com/x' }, ctx: { fetchText: async () => { called++; return ''; } } });
    assert.equal(res.status, 'UNKNOWN');
    assert.equal(called, 0);
  });

  it('returns terminal HTTP observations without retrying into them', async () => {
    const err429 = new Error('HTTP 429'); err429.status = 429;
    let calls = 0;
    const res = await dice.verifyJob({ job, ctx: { fetchText: async () => { calls++; throw err429; } } });
    assert.equal(res.status, 'RATE_LIMITED');
    assert.equal(calls, 1);
  });

  it('rethrows transport errors so the engine can retry them', async () => {
    await assert.rejects(
      dice.verifyJob({ job, ctx: { fetchText: async () => { throw new TypeError('socket hang up'); } } }),
      /socket hang up/,
    );
  });

  it('search parsing is unchanged (no provider rewrite)', () => {
    assert.equal(typeof parseDiceHtml, 'function');
    assert.equal(parseDiceHtml('').length, 0);
  });
});

describe('verification eval framework', () => {
  const fixtures = [
    { name: 'active', html: fx('active.html'), url: URL, expectedStatus: 'ACTIVE', classification: 'live-trimmed' },
    { name: 'not-found', html: fx('not-found.html'), url: URL, expectedStatus: 'NOT_FOUND', classification: 'live-trimmed' },
    { name: 'closed', html: fx('closed-synthetic.html'), url: URL, expectedStatus: 'CLOSED', classification: 'synthetic' },
    { name: 'blocked', html: fx('blocked-synthetic.html'), url: URL, expectedStatus: 'BLOCKED', classification: 'synthetic' },
    { name: 'malformed', html: fx('malformed.html'), url: URL, expectedStatus: 'UNKNOWN', classification: 'synthetic' },
    { name: 'http-404', status: 404, html: '', url: URL, expectedStatus: 'NOT_FOUND', classification: 'http-status' },
  ];

  it('tracks agreement per fixture without precision claims', () => {
    const out = evaluateVerificationFixtures({ providerId: 'dice', classify: classifyDiceDetailPage, fixtures });
    assert.equal(out.provider, 'dice');
    assert.equal(out.counts.total, 6);
    assert.equal(out.counts.agree, 6);
    assert.equal(out.counts.disagree, 0);
    assert.ok(out.rows.every((r) => r.agree));
    assert.ok(out.rows.every((r) => ['live-trimmed', 'synthetic', 'http-status'].includes(r.classification)));
    // No rates, no precision/recall keys anywhere in the output.
    assert.ok(!('precision' in out) && !('recall' in out) && !('accuracy' in out));
  });

  it('marks tiny samples insufficient and reports disagreements raw', () => {
    const out = evaluateVerificationFixtures({
      providerId: 'dice',
      classify: classifyDiceDetailPage,
      fixtures: [{ name: 'wrong', html: fx('active.html'), url: URL, expectedStatus: 'NOT_FOUND', classification: 'synthetic' }],
    });
    assert.equal(out.counts.disagree, 1);
    assert.deepEqual(out.byStatus, { 'NOT_FOUND→ACTIVE': 1 });
    assert.equal(out.sample.count, 1);
    assert.equal(out.sample.sufficient, false);
  });
});
