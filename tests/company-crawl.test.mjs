import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCompanyInput,
  slugVariantsFor,
  companyNameMatches,
} from '../lib/company-input.mjs';
import {
  isSafeHttpUrl,
  resolveCompany,
  crawlCompanyJobs,
} from '../lib/company-crawl.mjs';

describe('company input parsing (chat-friendly)', () => {
  it('splits comma/newline/semicolon lists and dedupes', () => {
    const r = parseCompanyInput('Qualcomm, Deckers Corporation\nqualcomm; UGG');
    assert.deepEqual(r.companies, ['Qualcomm', 'Deckers Corporation', 'UGG']);
    assert.equal(r.capped, false);
  });
  it('strips chatty wrappers', () => {
    assert.deepEqual(parseCompanyInput('find jobs at Qualcomm').companies, ['Qualcomm']);
    assert.deepEqual(parseCompanyInput('Deckers careers').companies, ['Deckers']);
    assert.deepEqual(parseCompanyInput('show me openings at "Cisco Systems,"').companies, ['Cisco Systems']);
  });
  it('splits a lone "X and Y" into two companies', () => {
    assert.deepEqual(parseCompanyInput('Qualcomm and Deckers').companies, ['Qualcomm', 'Deckers']);
    assert.deepEqual(parseCompanyInput('find jobs at Qualcomm and Deckers Corporation').companies, ['Qualcomm', 'Deckers Corporation']);
  });
  it('caps at 10 and reports dropped', () => {
    const many = Array.from({ length: 12 }, (_, i) => `Company${i + 1}`).join(', ');
    const r = parseCompanyInput(many);
    assert.equal(r.companies.length, 10);
    assert.equal(r.capped, true);
  });
  it('drops empties and single chars', () => {
    const r = parseCompanyInput('  , ,, A,');
    assert.deepEqual(r.companies, []);
    assert.ok(r.dropped.length > 0);
  });
});

describe('slugs + company matching', () => {
  it('derives dns slugs', () => {
    assert.ok(slugVariantsFor('Deckers Corporation').includes('deckers'));
    assert.ok(slugVariantsFor('Qualcomm').includes('qualcomm'));
  });
  it('matches both directions, rejects strangers', () => {
    assert.ok(companyNameMatches('Qualcomm Incorporated', 'Qualcomm'));
    assert.ok(companyNameMatches('Deckers', 'Deckers Outdoor Corporation'));
    assert.ok(!companyNameMatches('Acme Corp', 'Qualcomm'));
    assert.ok(!companyNameMatches('', 'Qualcomm'));
  });
  it('ssrf guard allows public https, rejects the rest', () => {
    assert.ok(isSafeHttpUrl('https://careers.qualcomm.com/careers'));
    assert.ok(!isSafeHttpUrl('http://careers.qualcomm.com/'));
    assert.ok(!isSafeHttpUrl('https://127.0.0.1/x'));
    assert.ok(!isSafeHttpUrl('https://10.0.0.5/'));
    assert.ok(!isSafeHttpUrl('https://169.254.169.254/'));
    assert.ok(!isSafeHttpUrl('not a url'));
  });
});

const stubProviders = (overrides = {}) => {
  const map = new Map(Object.entries({
    fakeats: {
      id: 'fakeats',
      detect: (entry) => (/fakeats\.example\.com/.test(entry?.careers_url || '') ? { url: entry.careers_url } : null),
      fetch: async () => [
        { title: 'Content Strategist', company: 'Acme', location: 'Austin, TX', url: 'https://fakeats.example.com/j/1' },
        { title: 'Janitor', company: 'Acme', location: 'Berlin', url: 'https://fakeats.example.com/j/2' },
      ],
    },
    ...overrides,
  }));
  return map;
};

describe('resolveCompany (stubbed network)', () => {
  it('claims via careers-page detect routing (no provider field on probes)', async () => {
    let seenEntry = null;
    const providers = new Map(Object.entries({
      picky: {
        id: 'picky',
        detect: (entry) => {
          seenEntry = entry;
          if (entry?.provider) return { url: 'https://picky.example.com/all' };
          return /picky\.example\.com/.test(entry?.careers_url || '') ? { url: entry.careers_url } : null;
        },
        fetch: async () => [],
      },
    }));
    const fetchFn = async (url) => ({
      ok: true,
      status: 200,
      url,
      text: async () => '<a href="https://jobs.picky.example.com/board">jobs</a>',
    });
    const r = await resolveCompany('Acme Corp', { providers, fetchFn });
    assert.equal(r.resolved, true);
    assert.equal(r.providerId, 'picky');
    assert.ok(seenEntry && !('provider' in seenEntry), 'probe entry must not carry provider');
  });
  it('reports unresolved when nothing claims', async () => {
    const fetchFn = async () => ({ ok: false, status: 404 });
    const r = await resolveCompany('No Such Company XYZ', { providers: stubProviders(), fetchFn });
    assert.equal(r.resolved, false);
    assert.ok(r.error);
  });
});

describe('crawlCompanyJobs (stubbed providers)', () => {
  it('fetches, filters non-US, upserts, records the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scav-cc-'));
    const fetchFn = async (url) => {
      if (String(url).includes('boards-api.greenhouse.io') || String(url).includes('api.lever.co') || String(url).includes('api.ashbyhq.com')) {
        return { ok: false, status: 404 };
      }
      return { ok: true, status: 200, url, text: async () => '<a href="https://jobs.fakeats.example.com/board">jobs</a>' };
    };
    const r = await crawlCompanyJobs({
      company: 'Acme',
      profiles: [],
      roleTerms: [],
      providerModules: stubProviders(),
      fetchFn,
      jobStorePath: join(dir, 'job-store.json'),
      runsDir: dir,
    });
    assert.equal(r.resolved, true);
    assert.equal(r.providerId, 'fakeats');
    assert.equal(r.status, 'COMPLETE');
    assert.equal(r.accepted, 1); // Berlin row dropped by US filter
    assert.equal(r.canonicalKeys.length, 1);
  });
});
