// NOT_FOUND precision measurement + reliable-absence gate (Phase 10 §5–7).
//
// Question answered: "when a provider says NOT_FOUND, how often is the job
// actually unavailable?" Synthetic and live observations are NEVER combined
// into one number — the module reports them side by side with sufficiency
// flags, and the gate consumes live evidence only.
//
// The gate produces a state + advisory recommendation. It NEVER flips
// provider.verify.reliableAbsence itself — a human applies the change after
// reading the numbers (Phase 10 §7, §18).

export const DEFAULT_PRECISION_SUFFICIENT = 30;

/**
 * Observation of one NOT_FOUND verdict against ground truth.
 * @typedef {object} NotFoundObservation
 * @property {string} provider
 * @property {'NOT_FOUND'|'OTHER'} observed what the provider said
 * @property {'unavailable'|'available'|null} confirmed ground truth (null = unconfirmed)
 * @property {'live'|'synthetic'|'http-status'} classification
 */

/**
 * Measure NOT_FOUND precision separately for live and synthetic evidence.
 * precision = confirmed-unavailable / all-confirmed. Null when nothing is
 * confirmed. Raw counts are always present; rates appear only beside them.
 */
export function measureNotFoundPrecision({ observations = [], sufficientThreshold = DEFAULT_PRECISION_SUFFICIENT } = {}) {
  const split = (classification) => {
    const rows = (Array.isArray(observations) ? observations : []).filter((o) => o && o.classification === classification);
    const notFound = rows.filter((o) => o.observed === 'NOT_FOUND');
    const unavailable = notFound.filter((o) => o.confirmed === 'unavailable').length;
    const available = notFound.filter((o) => o.confirmed === 'available').length;
    const unconfirmed = notFound.filter((o) => o.confirmed == null).length;
    const confirmed = unavailable + available;
    return {
      observations: rows.length,
      notFoundObserved: notFound.length,
      confirmedUnavailable: unavailable,
      confirmedAvailable: available,
      unconfirmed,
      precision: confirmed > 0 ? unavailable / confirmed : null,
      sample: { count: confirmed, sufficient: confirmed >= sufficientThreshold },
    };
  };
  return {
    live: split('live'),
    synthetic: split('synthetic'),
    httpStatus: split('http-status'),
  };
}

/**
 * Collect NOT_FOUND observations from durable verification histories.
 * Ground truth is NOT inferable from history alone (an observation is not a
 * verdict), so confirmed is always null here — these rows count live
 * observation VOLUME; confirmation arrives from manual review or later
 * explicit evidence, recorded via confirmNotFoundObservation().
 */
export function collectNotFoundObservations({ records = [] } = {}) {
  const out = [];
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    const history = Array.isArray(rec.verificationHistory) ? rec.verificationHistory : [];
    for (const e of history) {
      if (!e || typeof e !== 'object') continue;
      out.push({
        jobId: rec.jobId || null,
        provider: e.provider || null,
        observed: e.status === 'NOT_FOUND' ? 'NOT_FOUND' : 'OTHER',
        confirmed: null,
        classification: 'live',
        evidenceType: e.evidence?.type || null,
        checkedAt: e.checkedAt || null,
      });
    }
  }
  return out;
}

/**
 * Evaluate whether a provider may trial reliableAbsence.
 *
 * Thresholds (documented, not arbitrary):
 * - minLiveConfirmed (default 30): shared sufficient-sample convention used
 *   across outcome-metrics, search-quality, and verify-eval. Below it no
 *   rate is trustworthy.
 * - minPrecision (default 0.95): closure is destructive — a false closure
 *   silently drops a real opportunity from the feed. The bar is high
 *   because the cost of a false positive far exceeds a missed closure.
 * - minRepeatStability (default 3): mirrors absenceThreshold — the same
 *   job must read NOT_FOUND repeatedly before absence means anything.
 * - soft404Ambiguity (required input): true when the provider's NOT_FOUND
 *   travels over an ambiguous channel (Dice's HTTP-200 soft-404 title).
 *   An ambiguous channel caps the state at EVALUATING: measure all you
 *   want, but absence can never trial while the channel itself is suspect.
 */
export function evaluateAbsenceGate({
  providerId,
  reliableAbsence = false,
  liveConfirmed = 0,
  livePrecision = null,
  soft404Ambiguity = false,
  repeatStability = 0,
  minLiveConfirmed = DEFAULT_PRECISION_SUFFICIENT,
  minPrecision = 0.95,
  minRepeatStability = 3,
} = {}) {
  const reasons = [];
  const numbers = { liveConfirmed, livePrecision, repeatStability, minLiveConfirmed, minPrecision, minRepeatStability };
  if (!providerId) reasons.push('no provider id');
  if (liveConfirmed < minLiveConfirmed) {
    reasons.push(`only ${liveConfirmed} confirmed live observations (need ${minLiveConfirmed})`);
    return { provider: providerId || null, state: 'INSUFFICIENT_DATA', recommendedFlag: false, reasons, numbers };
  }
  if (soft404Ambiguity) {
    reasons.push('NOT_FOUND travels over an ambiguous channel (e.g. soft-404 page); measure, do not trial');
    return { provider: providerId || null, state: 'EVALUATING', recommendedFlag: false, reasons, numbers };
  }
  if (livePrecision == null) {
    reasons.push('no confirmed precision yet — observations exist but none are confirmed either way');
    return { provider: providerId || null, state: 'EVALUATING', recommendedFlag: false, reasons, numbers };
  }
  if (livePrecision < minPrecision) {
    reasons.push(`observed precision ${livePrecision.toFixed(3)} below floor ${minPrecision}`);
    return { provider: providerId || null, state: 'NOT_ELIGIBLE', recommendedFlag: false, reasons, numbers };
  }
  if (repeatStability < minRepeatStability) {
    reasons.push(`repeat stability ${repeatStability} below ${minRepeatStability} consecutive agreements`);
    return { provider: providerId || null, state: 'EVALUATING', recommendedFlag: false, reasons, numbers };
  }
  reasons.push(`meets trial bar: ${liveConfirmed} confirmed, precision ${livePrecision.toFixed(3)}, stability ${repeatStability}`);
  if (reliableAbsence) reasons.push('flag already enabled — re-evaluate periodically, do not assume permanence');
  return { provider: providerId || null, state: 'ELIGIBLE_FOR_TRIAL', recommendedFlag: reliableAbsence, reasons, numbers };
}
