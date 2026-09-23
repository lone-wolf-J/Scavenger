// Outcome measurement foundation (§10) — measurement only.
//
// Aggregates what happened (surfaced/viewed/saved/…/hired) broken down by
// match signals, for FUTURE calibration. This module never changes weights,
// never learns, never infers causality. It counts.

import { OUTCOMES } from './match-history.mjs';

/**
 * @param {object} history - match-history state ({matches})
 * @returns {{totals: Record<string,number>, bySignal: Record<string,Record<string,number>>,
 *   conversion: Record<string,number>, scored: number}}
 * conversion: stage-to-stage rates along the canonical funnel
 * (viewed|surfaced → saved → applied → interview → offer → hired).
 */
export function computeOutcomeMetrics(history) {
  const totals = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const bySignal = {};
  let scored = 0;
  for (const entry of Object.values(history?.matches || {})) {
    if (!entry || typeof entry !== 'object') continue;
    scored++;
    if (OUTCOMES.includes(entry.outcome)) totals[entry.outcome]++;
    const signals = [...(entry.matchedSignals || [])].slice(0, 10);
    for (const signal of signals) {
      const key = String(signal).toLowerCase();
      if (!bySignal[key]) bySignal[key] = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
      if (OUTCOMES.includes(entry.outcome)) bySignal[key][entry.outcome]++;
    }
  }
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);
  const reached = (stage) => totals[stage] || 0;
  const conversion = {
    'surfaced→viewed': rate(reached('viewed') + reached('saved') + reached('applied') + reached('interview') + reached('offer') + reached('hired'), Math.max(1, scored)),
    'viewed→saved': rate(reached('saved') + reached('applied') + reached('interview') + reached('offer') + reached('hired'), Math.max(1, reached('viewed') + reached('saved') + reached('applied') + reached('interview') + reached('offer') + reached('hired'))),
    'saved→applied': rate(reached('applied') + reached('interview') + reached('offer') + reached('hired'), Math.max(1, reached('saved') + reached('applied') + reached('interview') + reached('offer') + reached('hired'))),
    'applied→interview': rate(reached('interview') + reached('offer') + reached('hired'), Math.max(1, reached('applied') + reached('interview') + reached('offer') + reached('hired'))),
    'interview→offer': rate(reached('offer') + reached('hired'), Math.max(1, reached('interview') + reached('offer') + reached('hired'))),
    'offer→hired': rate(reached('hired'), Math.max(1, reached('offer') + reached('hired'))),
  };
  return { totals, bySignal, conversion, scored };
}
