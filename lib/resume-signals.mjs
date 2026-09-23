// Evidence-first resume signal extraction — domain-neutral.
//
// Every signal carries provenance:
//   explicit — directly stated in the resume (with quoted evidence)
//   inferred — reasonably derived from evidence (rule named, never a leap)
//   unknown  — not present (rewarded honesty: no fabrication, ever)
//
// Example: "Managed a team of 12 recruiters." →
//   leadershipSignals: [{ signal: 'peopleManagement', teamSize: 12,
//     provenance: 'inferred', rule: 'managed-team-size',
//     evidence: ['"Managed a team of 12 recruiters."'] }]
// It does NOT conclude "VP-level executive" — seniority comes only from
// title vocabulary + years, each step cited.

import { seniorityOf } from './match-score.mjs';

const sig = (value, provenance, evidence = [], extra = {}) => ({
  value, provenance, evidence: evidence.slice(0, 3), ...extra,
});

const SECTION_HEADS = [
  { re: /^(professional\s+)?summary|objective|profile$/i, name: 'summary' },
  { re: /^(work\s+)?experience|employment(\s+history)?|professional\s+experience$/i, name: 'experience' },
  { re: /^(technical\s+|core\s+)?skills(\s+and\s+technologies)?$/i, name: 'skills' },
  { re: /^(technologies|tech\s+stack|tools|technical\s+environment)$/i, name: 'technologies' },
  { re: /^education(\s+and\s+training)?|academic\s+background$/i, name: 'education' },
  { re: /^certifications?|licenses?|credentials$/i, name: 'certifications' },
  { re: /^projects?(\s+and\s+work)?$/i, name: 'projects' },
];

function splitSections(lines) {
  const sections = { header: [] };
  let current = 'header';
  for (const line of lines) {
    const clean = line.trim().replace(/[:\s]+$/, '');
    const hit = SECTION_HEADS.find((h) => h.re.test(clean.toLowerCase().replace(/[^a-z ]/g, '').trim()) && clean.length < 40);
    if (hit) {
      current = hit.name;
      sections[current] = sections[current] || [];
    } else if (line.trim()) {
      sections[current].push(line.trim());
    }
  }
  return sections;
}

const DATE_RANGE_RE = /((?:19|20)\d{2})\s*[–—\-to]+\s*((?:19|20)\d{2}|present|current|now)/i;
const MONTH_RANGE_RE = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+((?:19|20)\d{2})\s*[–—\-to]+\s*((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+)?((?:19|20)\d{2}|present|current|now)/i;

function parseRange(line, nowYear = new Date().getFullYear()) {
  const m = line.match(MONTH_RANGE_RE) || line.match(DATE_RANGE_RE);
  if (!m) return null;
  const years = [...line.matchAll(/((?:19|20)\d{2})/g)].map((x) => Number(x[1]));
  if (!years.length) return null;
  const start = years[0];
  const end = /present|current|now/i.test(line) ? nowYear : years[years.length - 1];
  if (end < start || start < 1970 || end > nowYear + 1) return null;
  return { start, end };
}

// "Senior HR Manager — Acme (2021–Present)" / "Backend Engineer at Beta, 2019-2022"
// A bare hyphen only separates when spaced ("Acme - Beta"); intra-word
// hyphens ("400-person") never do. Lines with sentence breaks (". X") are
// prose achievements, not role headers.
function parseRoleLine(line) {
  const range = parseRange(line);
  const noDates = line.replace(/\(?\s*(?:19|20)\d{2}\s*[–—\-to]+\s*(?:(?:19|20)\d{2}|present|current|now)\s*\)?/i, '').trim();
  if (/[.?!]\s+[A-Z]/.test(noDates)) return null;
  const m = noDates.match(/^(.{3,80}?)\s*(?:[—–]|\s+-\s+|\s*\|\s*|,|\bat\b)\s*(.{2,60})$/) || noDates.match(/^(.{3,80}?)\s{2,}(.{2,60})$/);
  if (!m) return null;
  const title = m[1].trim().replace(/^[-•*]\s*/, '');
  const company = m[2].trim();
  if (title.length < 3 || company.length < 2) return null;
  // Skip section debris and skill-like lines.
  if (/^(skills|technologies|tools|responsibilities|achievements)/i.test(title)) return null;
  return { title, company, range };
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/;
const LOCATION_RE = /\b([A-Z][a-zA-Z .'-]{1,30}),\s*([A-Z]{2})\b/;
const DEGREE_RE = /\b((?:B\.?S\.?|B\.?A\.?|M\.?S\.?|M\.?A\.?|MBA|Ph\.?D\.?|J\.?D\.?|Bachelor'?s?|Master'?s?(?!\s+thesis)|Associate'?s?|Doctorate)(?:\s+(?:of|in|degree))?)\b/i;
const TEAM_SIZE_RE = /\b(?:team|group|organization|org)\s+of\s+(\d{1,4})\b/i;
const MANAGED_RE = /\bmanag(?:ed|ing|e)\s+(?:a\s+team\s+of\s+)?(\d{1,4})\b/i;
const LED_COUNT_RE = /\bled\s+(\d{1,4})\s+(engineers|developers|recruiters|designers|analysts|reports|people|members)\b/i;
const MENTORED_RE = /\bmentored?\s+(\d{1,4})\b/i;
const BUDGET_RE = /\b(?:budget|p&l|revenue)\b[^.\n]{0,60}?\$([\d,.]+)\s*([kmb])?\b|\$([\d,.]+)\s*([kmb])?\b[^.\n]{0,40}?\b(?:budget|p&l|revenue)\b/i;
const SCOPE_WORDS = ['roadmap', 'strategy', 'stakeholders', 'p&l', 'profit and loss'];

/**
 * @param {string} text - extracted resume text
 * @param {{source?: string}} [opts]
 * @returns {object} signals per the Phase 3 schema (see header)
 */
export function extractResumeSignals(text, { source = 'resume' } = {}) {
  const empty = (reason) => ({ value: null, provenance: 'unknown', evidence: [], note: reason });
  if (typeof text !== 'string' || !text.trim()) {
    return {
      identity: empty('no text'), currentRoles: [], previousRoles: [], targetRoles: [],
      skills: [], technologies: [], domains: [], industries: [],
      functionalAreas: [], leadershipSignals: [], yearsExperience: empty('no text'),
      education: [], certifications: [], locations: [], workplacePrefs: [],
      employmentPrefs: [], compensationSignals: [], exclusions: [], evidence: [],
      source,
    };
  }
  const lines = text.split('\n');
  const sections = splitSections(lines);
  const quote = (l) => `"${l.length > 120 ? l.slice(0, 120) + '…' : l}"`;

  // ---- identity: first lines carry name/contact (explicit) ----
  const head = [...(sections.header || []), ...(sections.summary || [])].slice(0, 6);
  const identity = {};
  const nameLine = (sections.header || [])[0] || '';
  identity.name = nameLine && !EMAIL_RE.test(nameLine) && nameLine.length < 60
    ? sig(nameLine, 'explicit', ['document first line']) : empty('no name line');
  const contactLine = head.find((l) => EMAIL_RE.test(l)) || '';
  const email = (contactLine.match(EMAIL_RE) || [])[0] || '';
  identity.email = email ? sig(email, 'explicit', [quote(contactLine)]) : empty('no email found');
  const phoneLine = head.find((l) => PHONE_RE.test(l)) || '';
  const phone = (phoneLine.match(PHONE_RE) || [])[0] || '';
  identity.phone = phone ? sig(phone, 'explicit', [quote(phoneLine)]) : empty('no phone found');

  // ---- roles from experience lines ----
  const expLines = sections.experience || [];
  const roles = [];
  for (const line of expLines) {
    const parsed = parseRoleLine(line);
    if (parsed) {
      roles.push({
        title: parsed.title, company: parsed.company, range: parsed.range,
        provenance: 'explicit', evidence: [quote(line)],
      });
    }
  }
  const currentRoles = roles.slice(0, 1).map((r) => ({ ...r, kind: 'current' }));
  const previousRoles = roles.slice(1).map((r) => ({ ...r, kind: 'historical' }));

  // ---- years of experience: summed tenures (inferred, method cited) ----
  let yearsExperience = empty('no dated roles found');
  const tenures = roles.map((r) => r.range).filter(Boolean);
  if (tenures.length) {
  // Merge overlapping tenures so concurrent roles don't double-count.
  // (e - s) elapsed years: 2015–2019 plus 2019–2026 is 4 + 7 = 11.
  const spans = tenures.map((t) => [t.start, t.end]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  const years = merged.reduce((a, [s, e]) => a + (e - s), 0);
    yearsExperience = sig(years, 'inferred', tenures.map((t) => `${t.start}–${t.end}`), { method: 'merged-tenure-sum' });
  }

  // ---- skills / technologies (explicit section items) ----
  const splitItems = (arr) => [...new Set(
    (arr || []).flatMap((l) => l.replace(/^[-•*]\s*/, '').split(/[,•|]/))
      .map((s) => s.trim()).filter((s) => s && s.length <= 60),
  )].slice(0, 60);
  const skills = splitItems(sections.skills).map((t) => sig(t, 'explicit', ['Skills section']));
  const technologies = splitItems(sections.technologies).map((t) => sig(t, 'explicit', ['Technologies section']));

  // ---- leadership: counted evidence only, never a leap ----
  const leadershipSignals = [];
  const allText = lines.join('\n');
  const pushLead = (signal, detail, rule, line) => leadershipSignals.push({
    signal, ...detail, provenance: 'inferred', rule, evidence: [quote(line)],
  });
  for (const line of lines) {
    const tm = line.match(TEAM_SIZE_RE);
    if (tm) pushLead('teamLeadership', { teamSize: Number(tm[1]) }, 'team-of-N', line);
    const mm = line.match(MANAGED_RE);
    if (mm && !tm) pushLead('peopleManagement', { teamSize: Number(mm[1]) }, 'managed-N', line);
    const lm = line.match(LED_COUNT_RE);
    if (lm) pushLead('peopleManagement', { teamSize: Number(lm[1]), group: lm[2] }, 'led-N-group', line);
    const mm2 = !lm && line.match(MENTORED_RE);
    if (mm2) pushLead('peopleManagement', { teamSize: Number(mm2[1]) }, 'mentored-N', line);
    const bm = line.match(BUDGET_RE);
    if (bm) pushLead('budgetOwnership', { amount: `$${bm[1] || bm[3]}${bm[2] || bm[4] || ''}` }, 'budget-mention', line);
  }
  for (const w of SCOPE_WORDS) {
    const line = lines.find((l) => l.toLowerCase().includes(w));
    if (line) pushLead('strategicScope', { term: w }, 'scope-word', line);
  }

  // ---- education / certifications (explicit) ----
  const education = (sections.education || []).map((l) => {
    const dm = l.match(DEGREE_RE);
    return {
      line: l, degree: dm ? dm[1] : '', provenance: 'explicit', evidence: [quote(l)],
    };
  }).filter((e) => e.degree || e.line.length < 80);
  const certifications = (sections.certifications || []).flatMap((l) => l.split(/[,•]/).map((s) => s.trim()).filter(Boolean))
    // Years and bare numbers are dates, not credentials ("SHRM-SCP, 2021").
    .filter((t) => !/^\d{2,4}$/.test(t))
    .slice(0, 20).map((t) => sig(t, 'explicit', ['Certifications section']));

  // ---- location / workplace / employment / compensation ----
  const locations = [];
  const locLine = head.find((l) => LOCATION_RE.test(l)) || lines.find((l) => LOCATION_RE.test(l));
  if (locLine) {
    const lm = locLine.match(LOCATION_RE);
    locations.push(sig(`${lm[1].trim()}, ${lm[2]}`, 'explicit', [quote(locLine)]));
  }
  const workplacePrefs = [];
  const remoteLine = lines.find((l) => /\bremote\b/i.test(l));
  if (remoteLine && /open to|seeking|preference|remote-first/i.test(remoteLine)) {
    workplacePrefs.push(sig('remote', 'explicit', [quote(remoteLine)]));
  }
  const relocateLine = lines.find((l) => /willing to relocate|open to relocat/i.test(l));
  if (relocateLine) workplacePrefs.push(sig('open-to-relocate', 'explicit', [quote(relocateLine)]));
  const employmentPrefs = [];
  const empLine = lines.find((l) => /seeking (full-time|part-time|contract)/i.test(l));
  if (empLine) employmentPrefs.push(sig(empLine.match(/seeking (full-time|part-time|contract)/i)[1].toLowerCase(), 'explicit', [quote(empLine)]));
  const compensationSignals = [];
  const compLine = lines.find((l) => /compensat|salary|expected pay/i.test(l) && /\$[\d,]+/.test(l));
  if (compLine) compensationSignals.push(sig((compLine.match(/\$[\d,]+[kKmM]?/) || [])[0] || '', 'explicit', [quote(compLine)]));

  return {
    identity, currentRoles, previousRoles, targetRoles: [],
    skills, technologies, domains: [], industries: [],
    functionalAreas: [], leadershipSignals, yearsExperience,
    education, certifications, locations, workplacePrefs,
    employmentPrefs, compensationSignals, exclusions: [],
    evidence: [`extracted from ${source}: ${lines.length} lines, ${roles.length} role(s)`],
    source,
  };
}
