// Title intelligence — domain-neutral title classification and gating.
//
// Answers: is this title junior or senior? leadership or IC? client-facing
// or internal? These are properties of the TITLE, independent of any
// career profile. Profiles consume them (scorer vetoes, family negatives);
// portals.yml `title_filter` remains the user's own running filter.

import { seniorityOf } from './match-score.mjs';

export { seniorityOf };

const LEADERSHIP_RE = /\b(director|head|vp|vice president|chief|executive|manager|principal|staff)\b/i;
// "Lead" is leadership only with scope ("Team Lead", "Lead, ..."); a bare
// craft "Lead" ("Sales Lead" = lead list!) is not.
const LEAD_SCOPE_RE = /\b(team lead|lead,|lead -|lead \(|engineering lead|tech lead|project lead)\b/i;
const LEAD_FALSE_RE = /\b(sales lead|leads)\b/i;

// Client-facing work, in generic professional vocabulary: the role serves
// external customers through architecture, deployment, or success motions.
const CLIENT_FACING_RE = /\b(solutions|sales engineer|customer engineer|customer success|forward deployed|consultant|consulting|implementation|onboarding|professional services|pre-sales|presales|advocacy|developer relations|devrel)\b/i;

/** 'leadership' | 'ic' — scope-aware, title-only. */
export function titleScope(title) {
  const t = String(title || '');
  if (LEAD_FALSE_RE.test(t)) return 'ic';
  if (LEADERSHIP_RE.test(t)) return 'leadership';
  if (LEAD_SCOPE_RE.test(t)) return 'leadership';
  if (/\blead\b/i.test(t)) return 'ic';
  return 'ic';
}

/** True when the title describes customer-facing architecture/delivery work. */
export function isClientFacing(title) {
  return CLIENT_FACING_RE.test(String(title || ''));
}

/**
 * Build a gate predicate for one search family + profile.
 * Returns {pass, reasons[]} — positives need a token-overlap hit against
 * the family titles; negatives (profile exclusions + seniority-mismatch
 * junior markers) veto with a stated reason.
 */
export function titleGateFor(family, profile = {}) {
  const positives = (family?.positives || []).map((s) => String(s).toLowerCase());
  const exclusions = [...(profile?.exclusions || [])].map((s) => String(s).toLowerCase());
  const senior = /^(senior|staff|principal|lead|manager|director|head|vp|executive)/.test(
    String(profile?.seniority || '').toLowerCase(),
  );
  const famTokens = positives.flatMap((s) => s.split(/[^a-z0-9+#]+/).filter((w) => w.length > 2));
  const famSet = new Set(famTokens);
  return (title) => {
    const t = String(title || '');
    const lower = t.toLowerCase();
    const reasons = [];
    for (const ex of exclusions) {
      if (ex && lower.includes(ex)) return { pass: false, reasons: [`exclusion "${ex}"`] };
    }
    if (senior) {
      if (/\bjunior\b/i.test(t) && !/\b(senior|staff|principal|lead|manager|director|head|vp)\b/i.test(t)) {
        return { pass: false, reasons: ['junior marker vs senior profile'] };
      }
      if (/\bintern(ship|s)?\b/i.test(t)) return { pass: false, reasons: ['intern marker vs senior profile'] };
      if (/\bassociate\b/i.test(t) && !/\bassociate\s+(director|vp|vice president|dean|partner)\b/i.test(t)) {
        return { pass: false, reasons: ['associate (non-senior context) vs senior profile'] };
      }
    }
    const hit = lower.split(/[^a-z0-9+#]+/).filter((w) => w.length > 2 && famSet.has(w)).length;
    if (hit === 0) return { pass: false, reasons: ['no family title overlap'] };
    reasons.push(`${hit} family term overlap`);
    return { pass: true, reasons };
  };
}
