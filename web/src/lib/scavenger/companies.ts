// Target Companies service — company crawl + profile match,Agg-shaped.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { careerOpsRoot } from '@/lib/career-ops';
import { scavengerPaths } from './core';
import { getOpportunities, getSelectedProfiles } from './opportunities';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const MAX_RESULTS = 60;

async function crawlLib() {
  return import(
    /* webpackIgnore: true */ pathToFileURL(path.join(careerOpsRoot(), 'lib', 'company-crawl.mjs')).href
  );
}

export async function parseCompanies(text: string) {
  const mod = await crawlLib();
  const input = await import(
    /* webpackIgnore: true */ pathToFileURL(path.join(careerOpsRoot(), 'lib', 'company-input.mjs')).href
  );
  void mod;
  return input.parseCompanyInput(text);
}

export async function listCompanyCrawls(limit = 20) {
  const mod = await crawlLib();
  const { dir } = scavengerPaths();
  return mod.listCompanyCrawls({ runsDir: dir, limit });
}

export async function crawlCompany({
  company,
  profileIds,
  maxPages = 25,
}: {
  company: string;
  profileIds?: string[];
  maxPages?: number;
}) {
  const profiles = await getSelectedProfiles(profileIds);
  if (!profiles.length) {
    return { ok: false as const, error: 'no active profiles selected — create or select a profile first' };
  }
  const mod = await crawlLib();
  const { dir } = scavengerPaths();
  const crawl = await mod.crawlCompanyJobs({
    company: String(company || '').trim(),
    profiles: profiles.map((p: Any) => ({ id: p.id, profile: p.profile })),
    maxPages,
    maxAgeDays: 14,
    dataRoot: careerOpsRoot(),
    jobStorePath: path.join(dir, 'job-store.json'),
    runsDir: dir,
  });

  // Same aggregation as the Jobs page, narrowed to crawled jobs.
  const opp = await getOpportunities({ profileIds: profiles.map((p: Any) => p.id) });
  if (!opp.ok) {
    return { ok: true as const, crawl, results: [], totalMatched: 0, warning: opp.error };
  }
  const keys = new Set<string>(crawl.canonicalKeys || []);
  const urls = new Set<string>(crawl.canonicalUrls || []);
  const matched = ((opp as Any).results || []).filter(
    (a: Any) => keys.has(a.jobId) || (a.job && a.job.url && urls.has(a.job.url)),
  );
  return {
    ok: true as const,
    crawl: { ...crawl, canonicalKeys: undefined },
    results: matched.slice(0, MAX_RESULTS),
    totalMatched: matched.length,
    profiles: profiles.map((p: Any) => ({ id: p.id, name: p.name })),
  };
}
