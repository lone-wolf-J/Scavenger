// Application domain model — first-class entity separating "job exists" from
// "user is applying to this job". One job may have multiple applications if
// the user applies with different profiles.
//
// State machine (§2):
//   DISCOVERED → SAVED → READY_TO_APPLY → APPROVED → PREPARING → IN_PROGRESS
//     → ACTION_REQUIRED → SUBMITTED → (terminal: REJECTED | WITHDRAWN | HIRED)
//   Any state → FAILED (with retry path back to ACTION_REQUIRED or READY_TO_APPLY)
//   SUBMITTED → INTERVIEW → OFFER → HIRED
//
// Invalid transitions are rejected. Every transition is timestamped.

export const APPLICATION_STATUSES = [
  'DISCOVERED',    // Job found by discovery, no user action yet
  'SAVED',         // User saved the job
  'READY_TO_APPLY',// Application destination identified, ready for user action
  'APPROVED',      // User approved application (manual or auto-apply rules)
  'PREPARING',     // Application is being prepared (questions answered, resume selected)
  'IN_PROGRESS',   // Application agent is executing in browser
  'ACTION_REQUIRED',// Human intervention needed (CAPTCHA, MFA, login, unknown question)
  'SUBMITTED',     // Application actually submitted to employer
  'FAILED',        // Submission failed (may retry)
  'REJECTED',      // Employer rejected
  'WITHDRAWN',     // User withdrew application
  'INTERVIEW',     // Interview scheduled/in-progress
  'OFFER',         // Offer received
  'HIRED',         // Offer accepted
];

export const APPLICATION_MODES = [
  'MANUAL',        // User must click Apply themselves
  'ASSISTED',      // Scavenger prepares, user approves before submit
  'AUTOMATIC',     // Scavenger can submit when all rules satisfied
];

export const APPLICATION_METHODS = [
  'DIRECT_EMPLOYER', // Generic employer website
  'GREENHOUSE',
  'WORKDAY',
  'LEVER',
  'ASHBY',
  'LINKEDIN',
  'DICE',
  'INDEED',
  'OTHER',
];

// Forward-only transitions. Key = current state, value = allowed next states.
// 'any' is a special key meaning "can transition from any non-terminal state".
const TRANSITIONS = {
  DISCOVERED:     ['SAVED'],
  SAVED:          ['READY_TO_APPLY', 'DISCOVERED'],
  READY_TO_APPLY: ['APPROVED', 'SAVED'],
  APPROVED:       ['PREPARING'],
  PREPARING:      ['IN_PROGRESS', 'ACTION_REQUIRED', 'FAILED'],
  IN_PROGRESS:    ['ACTION_REQUIRED', 'SUBMITTED', 'FAILED'],
  ACTION_REQUIRED:['IN_PROGRESS', 'PREPARING', 'WITHDRAWN'],
  SUBMITTED:      ['INTERVIEW', 'REJECTED', 'WITHDRAWN', 'FAILED'],
  FAILED:         ['READY_TO_APPLY', 'ACTION_REQUIRED', 'PREPARING'],
  REJECTED:       [],  // terminal
  WITHDRAWN:      [],  // terminal
  INTERVIEW:      ['OFFER', 'REJECTED', 'WITHDRAWN'],
  OFFER:          ['HIRED', 'REJECTED', 'WITHDRAWN'],
  HIRED:          [],  // terminal
};

const TERMINAL = new Set(['REJECTED', 'WITHDRAWN', 'HIRED']);

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function canTransition(from, to) {
  if (!APPLICATION_STATUSES.includes(from)) return false;
  if (!APPLICATION_STATUSES.includes(to)) return false;
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/**
 * Create a new application record.
 */
export function createApplication({
  jobId,
  profileId,
  profileName,
  resumeName,
  method = 'DIRECT_EMPLOYER',
  mode = 'MANUAL',
  jobTitle,
  company,
  location,
  url,
  applyUrl,
}) {
  const now = new Date().toISOString();
  return {
    applicationId: `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    jobId,
    profileId,
    profileName: profileName || '',
    resumeName: resumeName || '',
    status: 'DISCOVERED',
    previousStatus: null,
    method,
    mode,
    jobTitle: jobTitle || '',
    company: company || '',
    location: location || '',
    url: url || '',
    applyUrl: applyUrl || '',
    // Application answers
    answers: {},
    // Rule evaluation (for auto-apply)
    ruleEvaluation: null,
    // Automation
    autoApplyEligible: false,
    autoApplyRejectionReasons: [],
    // Execution
    failureReason: null,
    failureCount: 0,
    lastAttemptAt: null,
    submittedAt: null,
    // Daily limit tracking
    dailySlotUsed: false,
    // Timestamps
    createdAt: now,
    updatedAt: now,
    // Audit trail
    auditLog: [{ status: 'DISCOVERED', at: now, detail: 'Application created' }],
  };
}

/**
 * Transition an application to a new status. Returns {ok, application, reason}.
 */
export function transitionApplication(app, toStatus, { detail = '', now } = {}) {
  if (!app || !APPLICATION_STATUSES.includes(app.status)) {
    return { ok: false, application: app, reason: 'invalid application' };
  }
  if (!canTransition(app.status, toStatus)) {
    return { ok: false, application: app, reason: `cannot transition from ${app.status} to ${toStatus}` };
  }
  const timestamp = now || new Date().toISOString();
  const updated = {
    ...app,
    previousStatus: app.status,
    status: toStatus,
    updatedAt: timestamp,
    auditLog: [...(app.auditLog || []), { status: toStatus, at: timestamp, detail }],
  };
  // Set convenience timestamps
  if (toStatus === 'SUBMITTED') updated.submittedAt = timestamp;
  if (toStatus === 'IN_PROGRESS') updated.lastAttemptAt = timestamp;
  if (toStatus === 'FAILED') {
    updated.failureCount = (app.failureCount || 0) + 1;
    updated.failureReason = detail || 'unknown error';
  }
  if (toStatus === 'ACTION_REQUIRED') {
    updated.failureReason = detail || 'human intervention needed';
  }
  return { ok: true, application: updated, reason: null };
}

/**
 * Detect duplicate application: same jobId + profileId (active, not terminal).
 */
export function isDuplicate(applications, jobId, profileId, excludeId) {
  return applications.some(
    (a) => a.jobId === jobId && a.profileId === profileId && a.applicationId !== excludeId && !isTerminal(a.status),
  );
}

/**
 * Get application method from job data.
 */
export function detectApplicationMethod(job) {
  const url = (job?.url || job?.applyUrl || '').toLowerCase();
  const sources = (job?.sources || []).map((s) => s.toLowerCase());
  if (url.includes('greenhouse.io') || sources.includes('greenhouse')) return 'GREENHOUSE';
  if (url.includes('workday') || sources.includes('workday')) return 'WORKDAY';
  if (url.includes('lever.co') || sources.includes('lever')) return 'LEVER';
  if (url.includes('ashbyhq') || sources.includes('ashby')) return 'ASHBY';
  if (url.includes('linkedin.com') || sources.includes('linkedin')) return 'LINKEDIN';
  if (url.includes('dice.com') || sources.includes('dice')) return 'DICE';
  if (url.includes('indeed.com') || sources.includes('indeed')) return 'INDEED';
  return 'DIRECT_EMPLOYER';
}

/**
 * Check if application method supports automation.
 */
export function isMethodAutomatable(method) {
  // Currently only DIRECT_EMPLOYER is supported for browser automation.
  // Greenhouse/Workday/etc. require specific adapters.
  return method === 'DIRECT_EMPLOYER' || method === 'GREENHOUSE' || method === 'LINKEDIN';
}

/**
 * Serialize to JSON-safe object.
 */
export function serializeApplication(app) {
  return { ...app };
}
