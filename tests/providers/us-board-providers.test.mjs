import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const CASES = [
  {
    id: 'indeed',
    html: `<div class="job_seen_beacon"><a href="/rc/clk?jk=abc123&x=1">  AI Engineer </a>`
      + `<span data-testid="company-name">Acme Corp</span><div data-testid="text-location">Austin, TX</div></div>`
      + `<div class="job_seen_beacon"><a href="/rc/clk?jk=abc123&x=2">AI Engineer</a></div>`,
    expect: { n: 1, title: 'AI Engineer', company: 'Acme Corp', location: 'Austin, TX', host: 'www.indeed.com' },
    blocked: '<html><body>captcha challenge</body></html>',
  },
  {
    id: 'careerbuilder',
    html: `<div><a href="/job/senior-ai-engineer-xyz789">Senior AI Engineer</a>`
      + `<div class="company">Acme Corp</div><div class="location">Remote - US</div></div>`,
    expect: { n: 1, title: 'Senior AI Engineer', company: 'Acme Corp', location: 'Remote - US', host: 'www.careerbuilder.com' },
    blocked: '<html><body>access denied</body></html>',
  },
  {
    id: 'monster',
    html: `<article><a href="https://www.monster.com/job-openings/senior-ai-engineer--abc">ML Engineer</a>`
      + `<div class="company">Acme</div><div class="location">Boston, MA</div></article>`,
    expect: { n: 1, title: 'ML Engineer', company: 'Acme', location: 'Boston, MA', host: 'www.monster.com' },
    blocked: '<html><body>cloudflare</body></html>',
  },
  {
    id: 'ziprecruiter',
    html: `<article class="job_result"><a href="/jobs/senior-ai-engineer-123">Solutions Architect</a>`
      + `<p class="company">Acme</p><p class="location">Denver, CO</p></article>`,
    expect: { n: 1, title: 'Solutions Architect', company: 'Acme', location: 'Denver, CO', host: 'www.ziprecruiter.com' },
    blocked: '<html><body>are you a robot</body></html>',
  },
  {
    id: 'techfetch',
    html: `<div><a href="/job-details?id=456">Contract AI Developer</a>`
      + `<span class="client">Staffing Co</span><span class="location">Dallas, TX</span></div>`,
    expect: { n: 1, title: 'Contract AI Developer', company: 'Staffing Co', location: 'Dallas, TX', host: 'www.techfetch.com' },
    blocked: '<html><body>datadome</body></html>',
  },
];

const PARSERS = {
  indeed: 'parseIndeedHtml',
  careerbuilder: 'parseCareerBuilderHtml',
  monster: 'parseMonsterHtml',
  ziprecruiter: 'parseZipRecruiterHtml',
  techfetch: 'parseTechFetchHtml',
};

describe('new US board providers', () => {
  for (const c of CASES) {
    it(`${c.id}: parses fixture, dedups, builds search URL, surfaces bot walls`, async () => {
      const mod = await import(`../../providers/${c.id}.mjs`);
      assert.equal(mod.default.id, c.id);
      assert.ok(mod.default.detect({ provider: c.id }));
      assert.equal(mod.default.detect({ careers_url: 'https://example.com' }), null);
      const jobs = mod[PARSERS[c.id]](c.html);
      assert.equal(jobs.length, c.expect.n, JSON.stringify(jobs));
      assert.equal(jobs[0].title, c.expect.title);
      assert.equal(jobs[0].company, c.expect.company);
      assert.equal(jobs[0].location, c.expect.location);
      assert.ok(new URL(jobs[0].url).hostname.endsWith(c.expect.host), jobs[0].url);
      assert.equal(jobs[0].source, c.id);
      assert.deepEqual(mod[PARSERS[c.id]](null), []);
      // fetch() through a mock ctx: one search URL, parsed jobs.
      const seen = [];
      const fetched = await mod.default.fetch(
        { query: 'AI', location: 'United States' },
        { fetchText: async (url) => { seen.push(url); return c.html; } },
      );
      assert.equal(fetched.length, c.expect.n);
      assert.ok(seen[0].includes(c.expect.host), seen[0]);
      // Bot wall -> throws with body attached (classifier maps to BLOCKED/REQUIRES_AUTH).
      await assert.rejects(
        () => mod.default.fetch({ query: 'x' }, { fetchText: async () => c.blocked }),
        (err) => typeof err.body === 'string' && err.body.length > 0,
      );
    });
  }

  it('benchinfo: honestly UNSUPPORTED, never returns jobs', async () => {
    const mod = await import('../../providers/benchinfo.mjs');
    assert.equal(mod.default.id, 'benchinfo');
    assert.equal(mod.SUPPORTED, false);
    await assert.rejects(() => mod.default.fetch({}, {}), /UNSUPPORTED/);
    const { runProvider } = await import('../../lib/provider-result.mjs');
    const res = await runProvider(mod.default, { name: 'BenchInfo' }, {});
    assert.equal(res.status, 'error');
    assert.equal(res.errorType, 'UNSUPPORTED');
  });

  it('mcp transport: describes the call, UNAVAILABLE in plain node', async () => {
    const mcp = await import('../../lib/mcp-transport.mjs');
    const entry = { provider: 'dice', transport: 'mcp', query: 'AI', mcp: { server: 'dice', tool: 'search_jobs' } };
    assert.equal(mcp.isMcpEntry(entry), true);
    assert.equal(mcp.isMcpEntry({ provider: 'dice' }), false);
    const call = mcp.describeMcpCall(entry);
    assert.equal(call.server, 'dice');
    assert.equal(call.tool, 'search_jobs');
    assert.equal(call.args.query, 'AI');
    const res = await mcp.runMcpProvider(entry);
    assert.equal(res.status, 'error');
    assert.equal(res.errorType, 'UNAVAILABLE');
  });
});
