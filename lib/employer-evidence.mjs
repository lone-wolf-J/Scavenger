// Employer evidence enrichment — offline, zero-token.
//
// For a MEDIUM-confidence employer candidate, squeeze more evidence out of
// data already in hand (posting URLs, apply URLs, ATS hosts, multi-source
// sightings) and recalculate confidence. Thresholds never move; evidence
// does. No network, no per-company requests, nothing rate-limited.

import { scoreEmployer } from './employer-discovery.mjs';

const BOARD_HOSTS = /(dice|linkedin|indeed|monster|ziprecruiter|careerbuilder|techfetch|benchinfo|solidjobs|glassdoor|simplyhired)\./i;

// ATS hosts prove a real employer requisition lives behind the posting.
const ATS_HOSTS = [
  { re: /greenhouse\.io/i, name: 'Greenhouse' },
  { re: /lever\.co/i, name: 'Lever' },
  { re: /ashbyhq\.com/i, name: 'Ashby' },
  { re: /myworkdayjobs\.com/i, name: 'Workday' },
  { re: /smartrecruiters\.com/i, name: 'SmartRecruiters' },
  { re: /workable\.com/i, name: 'Workable' },
  { re: /bamboohr\.com/i, name: 'BambooHR' },
  { re: /breezy\.hr/i, name: 'Breezy' },
  { re: /icims\.com/i, name: 'iCIMS' },
  { re: /jobvite\.com/i, name: 'Jobvite' },
  { re: /teamtailor\.com/i, name: 'Teamtailor' },
  { re: /personio\.(de|com)/i, name: 'Personio' },
  { re: /pinpointhq\.com/i, name: 'Pinpoint' },
  { re: /rippling\.com/i, name: 'Rippling' },
  { re: /eightfold\.ai/i, name: 'Eightfold' },
];

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Collect URL-derived evidence for one employer decision across its jobs.
 * @returns {{evidence: string[], careerUrl: string, ats: string[], linkedin: boolean}}
 */
export function collectUrlEvidence(decisionJobs) {
  const evidence = [];
  let careerUrl = '';
  const ats = new Set();
  let linkedin = false;
  for (const job of decisionJobs || []) {
    for (const url of [job?.applyUrl, job?.url, job?.sourceCompanyUrl]) {
      if (typeof url !== 'string' || !url.trim()) continue;
      const host = hostOf(url);
      if (!host) continue;
      if (/linkedin\.com\/company\//i.test(url)) {
        linkedin = true;
        continue;
      }
      if (BOARD_HOSTS.test(host)) continue; // the board itself is not evidence
      const atsHit = ATS_HOSTS.find((a) => a.re.test(host));
      if (atsHit) {
        ats.add(atsHit.name);
        continue;
      }
      // An employer-domain URL (careers page, corporate site) ties the
      // posting to a real company presence.
      if (!careerUrl) careerUrl = url.trim();
    }
  }
  if (ats.size) evidence.push(`ATS-hosted posting (${[...ats].join(', ')})`);
  if (careerUrl) evidence.push(`employer-domain URL: ${hostOf(careerUrl)}`);
  if (linkedin) evidence.push('LinkedIn company presence linked');
  return { evidence, careerUrl, ats: [...ats], linkedin };
}

/**
 * Re-score a medium decision with enriched evidence. Returns a new decision;
 * base score comes from scoreEmployer() so thresholds stay identical.
 * Enrichment can add at most +0.15 (one tier of movement, never low→high
 * in a single jump without multi-source corroboration).
 */
export function enrichDecision(decision, decisionJobs) {
  const base = scoreEmployer(
    { company: decision.name, location: decision.exampleLocation, url: decision.exampleJobUrl, sourceCompanyUrl: '' },
    { sources: decision.sources },
  );
  const { evidence, careerUrl } = collectUrlEvidence([
    { url: decision.exampleJobUrl, sourceCompanyUrl: decision.potentialCompanyUrl || '' },
    ...(decisionJobs || []),
  ]);
  let bonus = 0;
  if (evidence.some((e) => e.startsWith('ATS-hosted'))) bonus += 0.08;
  if (evidence.some((e) => e.startsWith('employer-domain'))) bonus += 0.07;
  if (evidence.some((e) => e.startsWith('LinkedIn'))) bonus += 0.05;
  if ((decision.sources || []).length > 1) bonus += 0.05;
  const confidence = Math.round(Math.min(1, base.confidence + Math.min(0.15, bonus)) * 100) / 100;
  const tier = confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'medium' : 'low';
  return {
    ...decision,
    confidence,
    tier,
    evidence: [...new Set([...(decision.evidence || []), ...evidence])],
    potentialCompanyUrl: careerUrl || decision.potentialCompanyUrl || '',
    enriched: true,
    promoted: decision.tier !== 'high' && tier === 'high',
  };
}
