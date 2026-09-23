// Application engine — orchestrates the application workflow.
// Sits between the web UI and the domain repositories.
// No browser automation here — that's the application-agent layer.

import {
  createApplication,
  transitionApplication,
  isDuplicate,
  detectApplicationMethod,
  isMethodAutomatable,
  APPLICATION_STATUSES,
} from './application.mjs';

import {
  evaluateRules,
} from './application-rules.mjs';

import {
  getAnswers,
  matchAnswers,
} from './application-answers.mjs';

/**
 * Create an application from a job + profile. Handles dedup and method detection.
 */
export function initiateApplication({
  job,
  profile,
  profileId,
  profileName,
  resumeName,
  applicationRepository,
  workspace,
}) {
  // Dedup check (§22)
  const existing = applicationRepository.findAny(job.jobId || job.url, profileId);
  if (existing) {
    return {
      ok: false,
      reason: 'duplicate',
      existing,
      message: existing.submittedAt
        ? `Already applied on ${new Date(existing.submittedAt).toLocaleDateString()}.`
        : `Application already exists (${existing.status}).`,
    };
  }

  const method = detectApplicationMethod(job);
  const applyUrl = job.applyUrl || job.url || '';

  const app = createApplication({
    jobId: job.jobId || job.url,
    profileId,
    profileName,
    resumeName,
    method,
    mode: 'MANUAL',
    jobTitle: job.title || '',
    company: job.company || '',
    location: job.location || '',
    url: job.url || '',
    applyUrl,
  });

  applicationRepository.create(app);

  // Prepare answers from stored profile answers
  const storedAnswers = getAnswers(workspace, profileId);
  const basicFields = [
    { key: 'email' }, { key: 'phone' }, { key: 'linkedinUrl' },
    { key: 'workAuthorization' }, { key: 'yearsExperience' },
  ];
  const { filled } = matchAnswers(basicFields, storedAnswers);
  if (Object.keys(filled).length > 0) {
    applicationRepository.update(app.applicationId, { answers: filled });
  }

  return { ok: true, application: app };
}

/**
 * Evaluate auto-apply eligibility for a job+profile combination.
 */
export function evaluateAutoApply({
  job,
  profile,
  match,
  rules,
  applicationRepository,
  profileId,
}) {
  const dailyCount = applicationRepository.countToday({ profileId, status: 'SUBMITTED' });
  return evaluateRules({ job, profile, match, rules, dailyCount });
}

/**
 * Prepare an application for submission — answers questions, selects resume.
 */
export function prepareApplication({
  applicationId,
  applicationRepository,
  workspace,
  profileId,
}) {
  const app = applicationRepository.get(applicationId);
  if (!app) return { ok: false, reason: 'application not found' };

  // Transition to PREPARING
  const t1 = transitionApplication(app, 'PREPARING', { detail: 'Preparing application' });
  if (!t1.ok) return { ok: false, reason: t1.reason };
  applicationRepository.update(applicationId, t1.application);

  // Load stored answers
  const storedAnswers = getAnswers(workspace, profileId);
  const mergedAnswers = { ...storedAnswers, ...(app.answers || {}) };

  return {
    ok: true,
    application: { ...t1.application, answers: mergedAnswers },
    method: app.method,
    isAutomatable: isMethodAutomatable(app.method),
    applyUrl: app.applyUrl,
  };
}

/**
 * Approve and open an application (direct — opens URL, marks ACTION_REQUIRED).
 */
export function openApplication({
  applicationId,
  applicationRepository,
}) {
  const app = applicationRepository.get(applicationId);
  if (!app) return { ok: false, reason: 'application not found' };

  // Transition: APPROVED → PREPARING (or READY_TO_APPLY → APPROVED → PREPARING)
  if (app.status === 'READY_TO_APPLY') {
    const t1 = transitionApplication(app, 'APPROVED', { detail: 'User approved application' });
    if (t1.ok) applicationRepository.update(applicationId, t1.application);
  }

  const current = applicationRepository.get(applicationId);
  const t2 = transitionApplication(current, 'IN_PROGRESS', { detail: 'Opening application in browser' });
  if (!t2.ok) return { ok: false, reason: t2.reason };
  applicationRepository.update(applicationId, t2.application);

  // After opening, the application is ACTION_REQUIRED (user must complete in browser)
  const current2 = applicationRepository.get(applicationId);
  const t3 = transitionApplication(current2, 'ACTION_REQUIRED', {
    detail: 'Application opened — complete in browser',
  });
  if (t3.ok) applicationRepository.update(applicationId, t3.application);

  return { ok: true, application: applicationRepository.get(applicationId) };
}

/**
 * Mark an application as submitted (only after actual submission confirmation).
 */
export function markSubmitted({
  applicationId,
  applicationRepository,
  detail = 'Application submitted',
}) {
  const app = applicationRepository.get(applicationId);
  if (!app) return { ok: false, reason: 'application not found' };

  const t = transitionApplication(app, 'SUBMITTED', { detail });
  if (!t.ok) return { ok: false, reason: t.reason };
  applicationRepository.update(applicationId, t.application);
  return { ok: true, application: applicationRepository.get(applicationId) };
}

/**
 * Mark an application as failed.
 */
export function markFailed({
  applicationId,
  applicationRepository,
  reason = 'Application failed',
}) {
  const app = applicationRepository.get(applicationId);
  if (!app) return { ok: false, reason: 'application not found' };

  const t = transitionApplication(app, 'FAILED', { detail: reason });
  if (!t.ok) return { ok: false, reason: t.reason };
  applicationRepository.update(applicationId, t.application);
  return { ok: true, application: applicationRepository.get(applicationId) };
}

/**
 * Get application summary for display.
 */
export function getApplicationSummary(app) {
  return {
    applicationId: app.applicationId,
    jobId: app.jobId,
    profileId: app.profileId,
    profileName: app.profileName,
    jobTitle: app.jobTitle,
    company: app.company,
    location: app.location,
    url: app.url,
    applyUrl: app.applyUrl,
    status: app.status,
    method: app.method,
    mode: app.mode,
    resumeName: app.resumeName,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    submittedAt: app.submittedAt,
    failureReason: app.failureReason,
  };
}
