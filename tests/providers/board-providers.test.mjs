import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('existing board providers (dice/linkedin/solidjobs)', () => {
  it('dice: parses cards, never fabricates employer', async () => {
    const { default: dice, parseDiceHtml } = await import('../../providers/dice.mjs');
    assert.equal(dice.id, 'dice');
    assert.ok(dice.detect({ provider: 'dice' }));
    assert.equal(dice.detect({ careers_url: 'https://example.com' }), null);
    const html = `
      <a data-testid="job-search-job-detail-link" href="/job-detail/abc-123?x=1">AI Engineer</a>
      <p data-testid="job-card-company-name">Acme Corp</p>
      <p class="text-foreground-light">Austin, TX • 2 days ago</p>
      <p id="salary-label">$120k - $150k</p>
      <a data-testid="job-search-job-detail-link" href="/job-detail/no-co">No Company Role</a>
      <p class="text-foreground-light">Remote</p>`;
    const jobs = parseDiceHtml(html);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].title, 'AI Engineer');
    assert.equal(jobs[0].url, 'https://www.dice.com/job-detail/abc-123');
    assert.equal(jobs[0].company, 'Acme Corp');
    assert.equal(jobs[0].location, 'Austin, TX');
    assert.ok(typeof jobs[0].postedAt === 'number');
    // Missing company -> empty string, never "Dice Employer".
    assert.equal(jobs[1].company, '');
    assert.deepEqual(parseDiceHtml(''), []);
    assert.deepEqual(parseDiceHtml(null), []);
    // fetch() with a mock ctx hits one search URL and parses.
    const seen = [];
    const ctx = {
      fetchText: async (url) => { seen.push(url); return html; },
    };
    const fetched = await dice.fetch({ query: 'AI', location: 'United States' }, ctx);
    assert.equal(fetched.length, 2);
    assert.ok(seen[0].startsWith('https://www.dice.com/jobs?'));
    assert.ok(seen[0].includes('location=United+States'));
  });

  it('linkedin: parses guest cards with pagination + dedup', async () => {
    const { default: linkedin, parseLinkedInGuestHtml } = await import('../../providers/linkedin.mjs');
    assert.equal(linkedin.id, 'linkedin');
    assert.ok(linkedin.detect({ provider: 'linkedin' }));
    const card = (id, title) => `<li><h3 class="base-search-card__title">${title}</h3>`
      + `<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${id}?ref=search"></a>`
      + `<h4 class="base-search-card__subtitle">Acme Inc</h4>`
      + `<span class="job-search-card__location">New York, NY</span>`
      + `<time datetime="2026-09-01"></time></li>`;
    const page1 = card('111', 'AI Engineer') + card('222', 'ML Engineer');
    const page2 = card('222', 'ML Engineer') + card('333', 'Data Scientist');
    let calls = 0;
    const ctx = {
      sleep: async () => {},
      fetchText: async () => (++calls === 1 ? page1 : page2),
    };
    const jobs = await linkedin.fetch({ query: 'AI', location: 'United States', max_pages: 2 }, ctx);
    assert.equal(calls, 2);
    // 222 deduped across pages.
    assert.deepEqual(jobs.map((j) => j.url).sort(), [
      'https://www.linkedin.com/jobs/view/111',
      'https://www.linkedin.com/jobs/view/222',
      'https://www.linkedin.com/jobs/view/333',
    ]);
    assert.equal(jobs[0].company, 'Acme Inc');
    assert.equal(jobs[0].location, 'New York, NY');
    assert.ok(typeof jobs[0].postedAt === 'number');
    assert.deepEqual(parseLinkedInGuestHtml('no cards here'), []);
  });

  it('solidjobs: validates URL, maps jobs, rejects bad payloads', async () => {
    const { default: solidjobs } = await import('../../providers/solidjobs.mjs');
    assert.equal(solidjobs.id, 'solidjobs');
    assert.ok(solidjobs.detect({ careers_url: 'https://solid.jobs/public-api/offers/it' }));
    assert.equal(solidjobs.detect({ careers_url: 'https://evil.com/public-api/offers/it' }), null);
    const good = { fetchJson: async () => ({ jobs: [{ title: 'T', url: 'https://x/y', company: 'C', locations: ['A', 'B'] }] }) };
    const jobs = await solidjobs.fetch({ name: 'S', careers_url: 'https://solid.jobs/public-api/offers/it' }, good);
    assert.equal(jobs[0].location, 'A, B');
    await assert.rejects(() => solidjobs.fetch({ name: 'S', careers_url: 'http://solid.jobs/public-api/offers/it' }, good), /HTTPS/);
    await assert.rejects(() => solidjobs.fetch({ name: 'S', careers_url: 'https://evil.com/public-api/offers/it' }, good), /untrusted/);
    await assert.rejects(
      () => solidjobs.fetch({ name: 'S', careers_url: 'https://solid.jobs/public-api/offers/it' }, { fetchJson: async () => ({ nope: 1 }) }),
      /unexpected API response/,
    );
  });
});

describe('provider-result envelope', () => {
  it('wraps success and classified failures', async () => {
    const { runProvider, classifyProviderError } = await import('../../lib/provider-result.mjs');
    const okRes = await runProvider({ id: 'p', fetch: async () => [{ a: 1 }] }, { name: 'E' }, {});
    assert.equal(okRes.status, 'success');
    assert.equal(okRes.jobs.length, 1);
    const badShape = await runProvider({ id: 'p', fetch: async () => 'nope' }, {}, {});
    assert.equal(badShape.status, 'error');
    assert.equal(badShape.errorType, 'INVALID_RESPONSE');
    const e429 = new Error('HTTP 429'); e429.status = 429;
    assert.deepEqual(classifyProviderError(e429), { errorType: 'RATE_LIMITED', retryable: true });
    const e403 = new Error('HTTP 403'); e403.status = 403;
    assert.equal(classifyProviderError(e403).errorType, 'BLOCKED');
    const eNet = new Error('socket hang up');
    assert.equal(classifyProviderError(eNet).retryable, true);
    const thrown = await runProvider({ id: 'p', fetch: async () => { throw e429; } }, {}, {});
    assert.equal(thrown.status, 'error');
    assert.equal(thrown.errorType, 'RATE_LIMITED');
    assert.equal(thrown.retryable, true);
  });
});

describe('provider-cache', () => {
  it('round-trips state, honors TTL, never throws', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const cache = await import('../../lib/provider-cache.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-cache-'));
    assert.equal(cache.loadCache(root, 'dice'), null);
    assert.equal(cache.isFresh(null), false);
    cache.recordSuccess(root, 'dice', { jobIds: ['a'], jobCount: 1 });
    const loaded = cache.loadCache(root, 'dice');
    assert.equal(loaded.jobCount, 1);
    assert.equal(cache.isFresh(loaded), true);
    assert.equal(cache.isFresh({ lastSuccess: Date.now() - 3600_000 * 5 }, 1000), false);
    cache.recordFailure(root, 'dice', { errorType: 'BLOCKED', message: 'nope' });
    assert.equal(cache.loadCache(root, 'dice').lastFailure.errorType, 'BLOCKED');
    fs.rmSync(root, { recursive: true, force: true });
  });
});


