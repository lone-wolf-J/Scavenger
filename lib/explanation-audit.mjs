// Match-explanation integrity audit (Phase 10 §15).
//
// Every reason/penalty the deterministic scorer emits interpolates profile
// fragments, job fragments, recomputed labels, or static rule descriptions.
// This auditor re-derives each claim from the SAME inputs and reports
// violations — unknown templates, fragments absent from the cited side, or
// trigger conditions that do not hold. It never rescores; it checks that
// what was said is backed by what was given.
//
// Reasonable conservatism is documented per rule: substring/token checks
// stand in for the scorer's internal token-fraction where those helpers are
// not exported. A violation means "not provably backed", not "false".

import { seniorityOf } from './match-score.mjs';
import { classifyUsLocation } from './us-location.mjs';

const low = (s) => String(s || '').toLowerCase();
const inProfileList = (frag, list) => (Array.isArray(list) ? list : []).some((t) => low(t) === low(frag));
const fragInJobText = (frag, job) => {
  const hay = `${job?.title || ''} ${job?.description || ''}`.toLowerCase();
  return frag && hay.includes(String(frag).toLowerCase());
};

/**
 * @param {{match: {reasons?: string[], penalties?: string[], matchedSignals?: string[], missingSignals?: string[]}, job?: object, profile?: object}} args
 * @returns {{checked: number, violations: Array<{reason: string, code: string, detail: string}>}}
 */
export function auditMatchExplanation({ match = {}, job = {}, profile = {} } = {}) {
  const violations = [];
  let checked = 0;
  const bad = (reason, code, detail) => violations.push({ reason, code, detail });

  const skillTerms = [...(profile.skills || []), ...(profile.technologies || [])];
  const domainTerms = [...(profile.functionalAreas || []), ...(profile.domains || []), ...(profile.industries || [])];
  const rolePhrases = [...(profile.targetRoles || []), ...(profile.currentRoles || [])];

  for (const reason of match.reasons || []) {
    checked++;
    let m;
    if ((m = reason.match(/^Strong title match(?:: "(.*)")?$/))) {
      if (m[1] && !inProfileList(m[1], rolePhrases)) bad(reason, 'FRAGMENT_NOT_IN_PROFILE', `"${m[1]}" is not a profile target/current role`);
      else if (!m[1] && !rolePhrases.length) bad(reason, 'TRIGGER_MISMATCH', 'profile has no roles to match');
    } else if ((m = reason.match(/^(\w+)-level scope (matches profile|\(stretch above profile\))$/))) {
      if (m[1] !== seniorityOf(job.title)) bad(reason, 'TRIGGER_MISMATCH', `recomputed scope is "${seniorityOf(job.title)}", not "${m[1]}"`);
    } else if (reason.startsWith('Skill match: ')) {
      for (const s of reason.slice('Skill match: '.length).split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!inProfileList(s, skillTerms)) bad(reason, 'FRAGMENT_NOT_IN_PROFILE', `"${s}" is not a profile skill/technology`);
        else if (!fragInJobText(s, job)) bad(reason, 'FRAGMENT_NOT_IN_JOB', `"${s}" appears nowhere in the job title/description`);
      }
    } else if (reason.startsWith('Domain match: ')) {
      for (const s of reason.slice('Domain match: '.length).split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!inProfileList(s, domainTerms)) bad(reason, 'FRAGMENT_NOT_IN_PROFILE', `"${s}" is not a profile domain/industry term`);
      }
    } else if ((m = reason.match(/^(\d+(?:\.\d+)?) years experience fits scope$/))) {
      if (Number(m[1]) !== Number(profile.yearsExperience)) bad(reason, 'FRAGMENT_NOT_IN_PROFILE', `profile has ${profile.yearsExperience} years, not ${m[1]}`);
    } else if ((m = reason.match(/^Identified employer: (.*)$/))) {
      if (m[1] !== (job.company || '')) bad(reason, 'FRAGMENT_NOT_IN_JOB', `"${m[1]}" is not the job's company`);
    } else if (reason === 'Company career site found') {
      if (!job.sourceCompanyUrl) bad(reason, 'TRIGGER_MISMATCH', 'job has no sourceCompanyUrl');
    } else if ((m = reason.match(/^Listed on (\d+) sources$/))) {
      if (Number(m[1]) !== (Array.isArray(job.sources) ? job.sources.length : 0)) bad(reason, 'COUNT_MISMATCH', `job lists ${Array.isArray(job.sources) ? job.sources.length : 0} sources`);
    } else if (reason === 'Compensation meets target') {
      if (!(job.salary?.min >= 1 && profile.compensationPrefs?.min > 0 && job.salary.min >= profile.compensationPrefs.min)) {
        bad(reason, 'TRIGGER_MISMATCH', 'salary minimums do not clear the profile target');
      }
    } else if (['US remote', 'US-based', 'Matches remote preference', 'Full-time role'].includes(reason)) {
      // The scorer reads job.country from the NORMALIZED job (derived from
      // the location string at match time); the stored record may not carry
      // it. Accept either the stored country or a US-derivable location —
      // both trace the claim to the job's location input.
      const derivedUs = classifyUsLocation(job.location || '', { url: job.url || '' }).verdict === 'us';
      const remote = /remote/i.test(job.location || '');
      const us = job.country === 'US' || (!job.country && derivedUs);
      if (reason === 'US remote' && !(remote && us)) bad(reason, 'TRIGGER_MISMATCH', 'needs remote location + US country');
      if (reason === 'US-based' && !us) bad(reason, 'TRIGGER_MISMATCH', 'needs US country');
      if (reason === 'Matches remote preference' && !((profile.workplacePrefs || []).some((w) => /remote/i.test(w)) && remote && us)) {
        bad(reason, 'TRIGGER_MISMATCH', 'needs remote workplace pref + remote US job');
      }
      if (reason === 'Full-time role' && !/full-time/i.test(`${job.employmentType || ''} ${job.title || ''} ${job.description || ''}`)) {
        bad(reason, 'FRAGMENT_NOT_IN_JOB', 'no full-time signal in job');
      }
    } else if ((m = reason.match(/^Matches employment preference \((.*)\)$/))) {
      if (!low(`${job.employmentType || ''} ${job.title || ''} ${job.description || ''}`).includes(low(m[1]))) {
        bad(reason, 'FRAGMENT_NOT_IN_JOB', `"${m[1]}" appears nowhere in the job`);
      }
    } else if (reason.startsWith('Leadership match: ')) {
      for (const s of reason.slice('Leadership match: '.length).split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!inProfileList(s, profile.leadershipSignals || [])) bad(reason, 'FRAGMENT_NOT_IN_PROFILE', `"${s}" is not a profile leadership signal`);
      }
    } else {
      bad(reason, 'UNKNOWN_TEMPLATE', 'reason matches no known scorer template');
    }
  }

  for (const penalty of match.penalties || []) {
    checked++;
    let m;
    if ((m = penalty.match(/^Exclusion hit: "(.*)"$/))) {
      if (!inProfileList(m[1], profile.exclusions || [])) bad(penalty, 'FRAGMENT_NOT_IN_PROFILE', `"${m[1]}" is not a profile exclusion`);
      else if (!low(job.title || '').includes(low(m[1]))) bad(penalty, 'FRAGMENT_NOT_IN_JOB', 'exclusion not present in job title');
    } else if ((m = penalty.match(/^Junior marker "(.*)" vs (.*)-level profile$/))) {
      if (!low(job.title || '').includes(low(m[1])) && low(m[1]) !== 'associate') bad(penalty, 'FRAGMENT_NOT_IN_JOB', 'marker not in job title');
      if (m[2] !== (profile.seniority || 'experienced')) bad(penalty, 'FRAGMENT_NOT_IN_PROFILE', `profile seniority is "${profile.seniority || ''}"`);
    } else if (penalty === 'Weak title match to target roles') {
      if (!rolePhrases.length) bad(penalty, 'TRIGGER_MISMATCH', 'profile has no roles');
    } else if ((m = penalty.match(/^Below profile seniority \((.*) vs (.*)\)$/))) {
      if (m[1] !== seniorityOf(job.title)) bad(penalty, 'TRIGGER_MISMATCH', `recomputed scope is "${seniorityOf(job.title)}"`);
      if (m[2] !== (profile.seniority || 'senior')) bad(penalty, 'FRAGMENT_NOT_IN_PROFILE', `profile seniority is "${profile.seniority || ''}"`);
    } else if (penalty === 'No profile skill/technology mentioned') {
      if (!skillTerms.length) bad(penalty, 'TRIGGER_MISMATCH', 'profile has no skills at all — nothing to miss');
    } else if ((m = penalty.match(/^(\d+(?:\.\d+)?) years experience vs (junior|executive)-scoped title$/))) {
      if (Number(m[1]) !== Number(profile.yearsExperience)) bad(penalty, 'FRAGMENT_NOT_IN_PROFILE', `profile has ${profile.yearsExperience} years`);
    } else if (penalty === 'Unknown employer') {
      if (job.company) bad(penalty, 'TRIGGER_MISMATCH', 'job names an employer');
    } else if (penalty === 'Below compensation target') {
      if (!(profile.compensationPrefs?.min > 0)) bad(penalty, 'TRIGGER_MISMATCH', 'profile sets no compensation target');
    } else if (penalty === 'Remote without US confirmation' || penalty === 'Location unconfirmed') {
      // Trigger-based on upstream country evidence, not on quoted text —
      // no fragment to verify. Conservative pass by definition.
    } else if ((m = penalty.match(/^(.*) position vs (.*) preference$/))) {
      if (!low(`${job.employmentType || ''} ${job.title || ''} ${job.description || ''}`).includes(low(m[1]))) {
        bad(penalty, 'FRAGMENT_NOT_IN_JOB', `"${m[1]}" appears nowhere in the job`);
      }
    } else if (penalty === 'Capped: exclusion veto') {
      // Operational note, not a factual claim — always backed by definition.
    } else {
      bad(penalty, 'UNKNOWN_TEMPLATE', 'penalty matches no known scorer template');
    }
  }

  const profileTerms = new Set([...skillTerms, ...domainTerms, ...(profile.leadershipSignals || [])].map((t) => low(t)));
  for (const s of [...(match.matchedSignals || []), ...(match.missingSignals || [])]) {
    checked++;
    if (!profileTerms.has(low(s))) bad(String(s), 'FRAGMENT_NOT_IN_PROFILE', 'signal is not a profile term');
  }
  return { checked, violations };
}
