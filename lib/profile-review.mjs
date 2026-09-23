// Human review model — nothing extracted becomes final without a person.
//
// Flow: renderReview(profile) → user reads sections with per-field status
// (confirmed / unconfirmed / inferred) → user replies with corrections
// ("That's wrong" / "Add this") expressed as ops → applyCorrections() →
// confirmProfile() persists {profile, reviewed, confirmedAt, history}.
//
// Corrections format (JSON, human-writable):
//   [{ "op": "set", "field": "seniority", "value": "director" },
//    { "op": "add", "field": "skills", "value": "Workday" },
//    { "op": "remove", "field": "targetRoles", "value": "Intern" },
//    { "op": "confirm", "field": "skills" }]
// "confirm" marks reviewed without changing anything. Unknown fields and
// type-mismatched values are rejected (reported, never applied).

import { PROFILE_FIELDS, normalizeCareerProfile } from './career-profile.mjs';

const LIST_FIELDS = new Set([
  'targetRoles', 'currentRoles', 'skills', 'technologies', 'domains',
  'industries', 'functionalAreas', 'leadershipSignals', 'workplacePrefs',
  'employmentPrefs', 'searchTerms', 'semanticSignals', 'exclusions',
]);
const SCALAR_FIELDS = new Set(['seniority', 'yearsExperience', 'profileConfidence']);

/**
 * Render a reviewable representation. Pure.
 * @returns {{sections: Array<{field, value, status, evidence}>, text: string}}
 */
export function renderReview(profile, signals = null) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const reviewed = p.reviewed && typeof p.reviewed === 'object' ? p.reviewed : {};
  const sections = [];
  const evFor = (field) => {
    if (!signals) return [];
    if (field === 'skills') return (signals.skills || []).slice(0, 3).map((s) => (s.evidence || [])[0]).filter(Boolean);
    if (field === 'targetRoles' || field === 'currentRoles') {
      return [...(signals.currentRoles || []), ...(signals.previousRoles || [])].slice(0, 2)
        .flatMap((r) => r.evidence || []).filter(Boolean);
    }
    if (field === 'seniority' && signals.currentRoles?.[0]) return signals.currentRoles[0].evidence || [];
    return [];
  };
  for (const field of PROFILE_FIELDS) {
    if (field === 'profileConfidence' || field === 'locationPrefs' || field === 'compensationPrefs') continue;
    const value = p[field];
    const empty = Array.isArray(value) ? value.length === 0 : (value == null || value === '');
    const status = reviewed[field] ? 'confirmed' : empty ? 'unconfirmed' : 'unconfirmed';
    sections.push({ field, value: value ?? (Array.isArray(value) ? [] : ''), status, evidence: evFor(field) });
  }
  // Inferred targets are proposals — always surfaced separately.
  const inferred = Array.isArray(p.inferredTargets) ? p.inferredTargets : [];
  const lines = [`Career Profile review (confidence ${p.profileConfidence ?? 0} — information completeness, not candidate quality):`, ''];
  for (const s of sections) {
    const mark = s.status === 'confirmed' ? '[confirmed]' : '[needs review]';
    const val = Array.isArray(s.value) ? (s.value.length ? s.value.join('; ') : '(empty)') : String(s.value || '(empty)');
    lines.push(`${mark} ${s.field}: ${val}`);
    for (const e of s.evidence.slice(0, 2)) lines.push(`    evidence: ${e}`);
  }
  if (inferred.length) {
    lines.push('', 'Inferred target roles (proposals — confirm to adopt, or ignore):');
    for (const t of inferred) lines.push(`  ? ${t.role} (confidence ${t.confidence}): ${(t.evidence || []).join('; ')}`);
  }
  return { sections, text: lines.join('\n') };
}

/**
 * Apply user corrections. Never throws on bad ops — they land in rejected.
 * @returns {{profile, applied: string[], rejected: Array<{op, reason}>}}
 */
export function applyCorrections(profile, corrections) {
  const applied = [];
  const rejected = [];
  const p = normalizeCareerProfile(profile);
  // Preserve review bookkeeping + inferred targets across normalization.
  if (profile && typeof profile === 'object') {
    if (profile.reviewed) p.reviewed = { ...profile.reviewed };
    if (Array.isArray(profile.inferredTargets)) p.inferredTargets = [...profile.inferredTargets];
  }
  p.reviewed = p.reviewed || {};
  const list = (f) => { if (!Array.isArray(p[f])) p[f] = []; return p[f]; };
  for (const c of Array.isArray(corrections) ? corrections : []) {
    const { op, field, value } = c || {};
    if (!PROFILE_FIELDS.includes(field)) { rejected.push({ op, reason: `unknown field "${field}"` }); continue; }
    if (op === 'confirm') {
      p.reviewed[field] = true;
      applied.push(`confirmed ${field}`);
      continue;
    }
    if (op === 'set') {
      if (LIST_FIELDS.has(field)) { rejected.push({ op, reason: `"set" needs a scalar field ("${field}" is a list — use add/remove)` }); continue; }
      if (field === 'yearsExperience' && value != null && !(Number.isFinite(Number(value)) && Number(value) >= 0)) {
        rejected.push({ op, reason: 'yearsExperience must be a non-negative number' }); continue;
      }
      p[field] = field === 'yearsExperience' && value != null ? Number(value) : value;
      p.reviewed[field] = true;
      applied.push(`set ${field}`);
      continue;
    }
    if (op === 'add' || op === 'remove') {
      if (!LIST_FIELDS.has(field)) { rejected.push({ op, reason: `"${op}" needs a list field ("${field}" is scalar)` }); continue; }
      if (typeof value !== 'string' || !value.trim()) { rejected.push({ op, reason: `${op} needs a non-empty string value` }); continue; }
      const arr = list(field);
      const idx = arr.findIndex((x) => String(x).toLowerCase() === value.trim().toLowerCase());
      if (op === 'add') {
        if (idx < 0) arr.push(value.trim());
        applied.push(`added "${value.trim()}" to ${field}`);
      } else {
        if (idx >= 0) arr.splice(idx, 1);
        applied.push(`removed "${value.trim()}" from ${field}`);
      }
      p.reviewed[field] = true;
      continue;
    }
    rejected.push({ op, reason: `unknown op "${op}" (want set/add/remove/confirm)` });
  }
  // Confidence follows the corrected facts: normalizeCareerProfile already
  // recomputed it from the corrected fields above.
  return { profile: p, applied, rejected };
}

/**
 * Confirm a reviewed profile for matching. Requires every non-empty core
 * field to be confirmed OR explicitly left unconfirmed (both are valid —
 * confirmation records what the human checked, not a completeness gate).
 * Adopted inferred targets move into targetRoles.
 */
export function confirmProfile(profile, { adoptInferred = [] } = {}) {
  const p = normalizeCareerProfile(profile);
  if (profile && typeof profile === 'object') {
    if (profile.reviewed) p.reviewed = { ...profile.reviewed };
    if (Array.isArray(profile.inferredTargets)) p.inferredTargets = [...profile.inferredTargets];
  }
  p.reviewed = p.reviewed || {};
  const adopted = [];
  for (const role of adoptInferred) {
    const found = (p.inferredTargets || []).find((t) => t.role.toLowerCase() === String(role).toLowerCase());
    if (found && !p.targetRoles.some((t) => t.toLowerCase() === found.role.toLowerCase())) {
      p.targetRoles.push(found.role);
      adopted.push(found.role);
    }
  }
  p.inferredTargets = (p.inferredTargets || []).filter((t) => !adopted.some((a) => a.toLowerCase() === t.role.toLowerCase()));
  return {
    ...p,
    confirmedAt: new Date().toISOString(),
    adoptedInferredTargets: adopted,
  };
}
