// Personalization-readiness gates (Phase 10 §17–18, §20).
//
// Phase 10 does NOT personalize. This module defines the CONDITIONS under
// which personalization could safely be considered later — per-dimension
// minimums with sufficient flags, never one global threshold, and an
// explicit future boundary:
//
//   observed behavior → descriptive analysis → candidate adjustment
//   → HUMAN/EXPLICIT APPROVAL → new matcher/search version (reversible)
//
// user action → automatic score change is PROHIBITED in Phase 10. Any future
// learned change must be versioned and reversible (see calibration-study.json).
//
// Thresholds below are documented starting points (params, not constants):
// - surfaced 100: band/signal breakdowns need dozens per cell to be stable.
// - viewed 30: shared sufficient-sample convention (outcome-metrics).
// - saved/rejected 10 each: the minimum contrast pair for any preference
//   signal — fewer saves than this cannot distinguish taste from noise.
// - applied 5: downstream commitment; rare by nature, so the bar is low but
//   nonzero (zero applications = no evidence about what converts).
// - outcome diversity 3: at least three distinct terminal outcomes observed
//   (e.g. saved + rejected + applied), otherwise the data describes one
//   behavior, not a preference.
// - per-signal observations 30: same convention; a signal seen less often
//   cannot carry a learned weight.

export const READINESS_DEFAULTS = {
  minSurfaced: 100,
  minViewed: 30,
  minSaved: 10,
  minRejected: 10,
  minApplied: 5,
  minOutcomeDiversity: 3,
  minPerSignal: 30,
};

const gate = (count, minimum) => ({ count, minimum, sufficient: count >= minimum });

/**
 * @param {object} args
 * @param {{surfaced, viewed, saved, rejected, applied}} args.outcomes funnel totals
 * @param {Array<string>} [args.distinctOutcomes] terminal outcomes observed
 * @param {Array<{signal, samples}>} [args.signalSamples] per-signal volumes
 * @param {object} [args.minimums] overrides for READINESS_DEFAULTS
 */
export function personalizationReadiness({
  outcomes = {},
  distinctOutcomes = [],
  signalSamples = [],
  minimums = {},
} = {}) {
  const m = { ...READINESS_DEFAULTS, ...minimums };
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const dimensions = {
    surfaced: gate(n(outcomes.surfaced), m.minSurfaced),
    viewed: gate(n(outcomes.viewed), m.minViewed),
    saved: gate(n(outcomes.saved), m.minSaved),
    rejected: gate(n(outcomes.rejected), m.minRejected),
    applied: gate(n(outcomes.applied), m.minApplied),
    outcomeDiversity: gate(new Set(distinctOutcomes).size, m.minOutcomeDiversity),
    perSignal: {
      minimum: m.minPerSignal,
      signals: (Array.isArray(signalSamples) ? signalSamples : []).map((s) => ({
        signal: s.signal,
        samples: n(s.samples),
        sufficient: n(s.samples) >= m.minPerSignal,
      })),
    },
  };
  dimensions.perSignal.sufficient =
    dimensions.perSignal.signals.length > 0 && dimensions.perSignal.signals.every((s) => s.sufficient);
  const ready = ['surfaced', 'viewed', 'saved', 'rejected', 'applied', 'outcomeDiversity', 'perSignal']
    .every((k) => dimensions[k].sufficient);
  return { ready, dimensions, minimums: m };
}

/**
 * Cold-start behavior (Phase 10 §20): what a new profile gets at each
 * outcome volume. The system ALWAYS uses deterministic baseline scoring —
 * no profile loses functionality for lack of history.
 */
export function coldStartStage({ outcomeCount = 0 } = {}) {
  const n = Number.isFinite(outcomeCount) && outcomeCount >= 0 ? outcomeCount : 0;
  const base = { scoring: 'deterministic-baseline', personalization: 'off', functionality: 'full' };
  if (n <= 0) return { stage: 'zero', outcomeCount: n, ...base, note: 'no outcomes: baseline matching + full discovery, nothing to calibrate against' };
  if (n === 1) return { stage: 'one', outcomeCount: n, ...base, note: 'a single outcome cannot distinguish preference from chance' };
  if (n < 10) return { stage: 'few', outcomeCount: n, ...base, note: 'outcomes counted descriptively (insufficient for any learned change)' };
  if (n < 30) return { stage: 'growing', outcomeCount: n, ...base, note: 'band-level patterns may emerge; still below per-signal minimums' };
  return { stage: 'established', outcomeCount: n, ...base, note: 'volume exists but personalization still requires explicit approval + versioning (see gates)' };
}
