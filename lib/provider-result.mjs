// Structured provider results: one provider failing never kills a scan.
//
// Every provider fetch should be wrapped with runProvider() so the scanner
// gets a uniform envelope instead of a thrown exception:
//
//   { status: 'success', jobs, metadata: { provider, elapsedMs, pages?, cached? } }
//   { status: 'error', errorType, message, retryable, metadata }
//
// errorType is a closed set: UNAVAILABLE | REQUIRES_AUTH | BLOCKED |
// RATE_LIMITED | UNSUPPORTED | FETCH_ERROR | INVALID_RESPONSE.

export const ERROR_TYPES = new Set([
  'UNAVAILABLE',
  'REQUIRES_AUTH',
  'BLOCKED',
  'RATE_LIMITED',
  'UNSUPPORTED',
  'FETCH_ERROR',
  'INVALID_RESPONSE',
]);

export function ok(jobs, metadata = {}) {
  return { status: 'success', jobs: Array.isArray(jobs) ? jobs : [], metadata };
}

export function fail(errorType, message, { retryable = false, metadata = {} } = {}) {
  return {
    status: 'error',
    errorType: ERROR_TYPES.has(errorType) ? errorType : 'FETCH_ERROR',
    message: String(message || 'unknown provider error'),
    retryable,
    metadata,
  };
}

/**
 * Classify a raw fetch error into the closed errorType set.
 * - 401/403 + login/captcha markers -> REQUIRES_AUTH / BLOCKED
 * - 429 -> RATE_LIMITED (retryable)
 * - 5xx / network (no status) -> FETCH_ERROR (retryable)
 * - anything else -> FETCH_ERROR (not retryable)
 */
export function classifyProviderError(err) {
  const status = err && typeof err.status === 'number' ? err.status : null;
  const body = typeof err?.body === 'string' ? err.body : '';
  const msg = String(err?.message || err || '');
  const challenge = /captcha|cloudflare|challenge|sign in|log in|login required|access denied|unusual traffic/i.test(`${msg} ${body.slice(0, 2000)}`);
  if (status === 401 || (status === 403 && /login|sign.?in|auth/i.test(`${msg} ${body.slice(0, 2000)}`))) {
    return { errorType: 'REQUIRES_AUTH', retryable: false };
  }
  if (status === 403 || status === 451 || (status === 429 && challenge)) {
    return { errorType: 'BLOCKED', retryable: false };
  }
  if (status === 429) return { errorType: 'RATE_LIMITED', retryable: true };
  if (status === null || status >= 500) return { errorType: 'FETCH_ERROR', retryable: true };
  return { errorType: 'FETCH_ERROR', retryable: false };
}

/**
 * Run a provider fetch inside the structured envelope. Never throws for
 * provider-side failures; only rethrows programmer errors (non-Error
 * rejections are wrapped too).
 */
export async function runProvider(provider, entry, ctx) {
  const started = Date.now();
  const baseMeta = { provider: provider?.id || 'unknown', entry: entry?.name || '' };
  // Provider messages often already carry their own id prefix
  // (unsupported() does); never double it.
  const withId = (msg) => {
    const m = String(msg);
    return m.startsWith(`${baseMeta.provider}:`) ? m : `${baseMeta.provider}: ${m}`;
  };
  try {
    if (!provider || typeof provider.fetch !== 'function') {
      return fail('UNSUPPORTED', `provider has no fetch(): ${baseMeta.provider}`, { metadata: baseMeta });
    }
    const jobs = await provider.fetch(entry, ctx);
    if (!Array.isArray(jobs)) {
      return fail('INVALID_RESPONSE', `${baseMeta.provider}: fetch() did not return an array`, { metadata: baseMeta });
    }
    return ok(jobs, { ...baseMeta, elapsedMs: Date.now() - started, count: jobs.length });
  } catch (err) {
    // A provider may declare its own terminal state (e.g. benchinfo has no
    // public job-search endpoint -> UNSUPPORTED). Honored verbatim.
    if (err && ERROR_TYPES.has(err.providerErrorType)) {
      return fail(err.providerErrorType, withId(err.message), {
        retryable: err.retryable === true,
        metadata: { ...baseMeta, elapsedMs: Date.now() - started },
      });
    }
    const { errorType, retryable } = classifyProviderError(err);
    return fail(errorType, withId(err?.message || err), {
      retryable,
      metadata: { ...baseMeta, elapsedMs: Date.now() - started },
    });
  }
}
