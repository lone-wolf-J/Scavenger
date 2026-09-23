// Application rules engine — evaluates whether a job+profile combination
// qualifies for automatic application. Rules are per-profile and user-configurable.
//
// Each rule produces a pass/fail with a reason. Auto-apply requires ALL rules to pass.

export const DEFAULT_RULES = {
  mode: 'MANUAL',              // MANUAL | ASSISTED | AUTOMATIC
  matchThreshold: 75,          // Minimum match score (0-100)
  requireUSTrue: true,         // Must be US location
  workplacePrefs: [],          // Empty = any; ['Remote', 'Hybrid'] = those only
  employmentPrefs: [],         // Empty = any; ['Full-time'] = full-time only
  seniorityPrefs: [],          // Empty = any; ['Director', 'VP'] = those only
  salaryMin: 0,                // Minimum salary (0 = no minimum)
  targetRoles: [],             // Empty = any; specific roles to match against
  excludedCompanies: [],       // Never auto-apply to these
  dailyLimit: 5,               // Max applications per day
  requireApprovalIf: {
    salaryUnavailable: true,
    locationAmbiguous: true,
    roleDiffersFromTarget: true,
    screeningQuestionsRequireUnknown: true,
    requiresCAPTCHA: true,
    requiresInfoNotInProfile: true,
  },
};

/**
 * Evaluate a job+profile+match against the auto-apply rules.
 * Returns { eligible, passes[], failures[], decision }.
 */
export function evaluateRules({ job, profile, match, rules, dailyCount, now }) {
  const r = { ...DEFAULT_RULES, ...rules };
  const passes = [];
  const failures = [];

  // Match threshold
  const score = match?.score ?? 0;
  if (score >= r.matchThreshold) {
    passes.push({ rule: 'matchThreshold', detail: `${score}% >= ${r.matchThreshold}%` });
  } else {
    failures.push({ rule: 'matchThreshold', detail: `${score}% < ${r.matchThreshold}%` });
  }

  // US location
  if (r.requireUSTrue) {
    const loc = (job?.location || '').toLowerCase();
    const isUS = /\b(us|united\s*states?|usa|u\.s\.a?\.?|remote)\b/i.test(loc) || !loc;
    if (isUS) {
      passes.push({ rule: 'location', detail: 'US location confirmed' });
    } else {
      failures.push({ rule: 'location', detail: `non-US location: ${job?.location || 'unknown'}` });
    }
  }

  // Workplace preference
  if (r.workplacePrefs.length > 0) {
    const wp = (job?.workplaceType || '').toLowerCase();
    const matches = r.workplacePrefs.some((p) => wp.includes(p.toLowerCase()));
    if (matches) {
      passes.push({ rule: 'workplace', detail: `matches ${r.workplacePrefs.join('/')}` });
    } else {
      failures.push({ rule: 'workplace', detail: `workplace "${job?.workplaceType || 'unknown'}" not in preferences` });
    }
  }

  // Employment preference
  if (r.employmentPrefs.length > 0) {
    const ep = (job?.employmentType || '').toLowerCase();
    const matches = r.employmentPrefs.some((p) => ep.includes(p.toLowerCase()));
    if (matches) {
      passes.push({ rule: 'employment', detail: `matches ${r.employmentPrefs.join('/')}` });
    } else {
      failures.push({ rule: 'employment', detail: `employment "${job?.employmentType || 'unknown'}" not in preferences` });
    }
  }

  // Seniority preference
  if (r.seniorityPrefs.length > 0) {
    const title = (job?.title || '').toLowerCase();
    const matches = r.seniorityPrefs.some((p) => title.includes(p.toLowerCase()));
    if (matches) {
      passes.push({ rule: 'seniority', detail: `matches seniority prefs` });
    } else {
      failures.push({ rule: 'seniority', detail: 'title does not match seniority preferences' });
    }
  }

  // Salary minimum
  if (r.salaryMin > 0) {
    const salary = job?.salary;
    if (salary && typeof salary === 'object' && salary.min >= r.salaryMin) {
      passes.push({ rule: 'salary', detail: `$${salary.min} >= $${r.salaryMin}` });
    } else if (typeof salary === 'number' && salary >= r.salaryMin) {
      passes.push({ rule: 'salary', detail: `$${salary} >= $${r.salaryMin}` });
    } else {
      if (r.requireApprovalIf.salaryUnavailable) {
        failures.push({ rule: 'salary', detail: 'salary unavailable or below minimum' });
      } else {
        passes.push({ rule: 'salary', detail: 'salary check waived' });
      }
    }
  }

  // Target roles
  if (r.targetRoles.length > 0) {
    const title = (job?.title || '').toLowerCase();
    const matches = r.targetRoles.some((role) => title.includes(role.toLowerCase()));
    if (matches) {
      passes.push({ rule: 'targetRoles', detail: 'matches target roles' });
    } else {
      if (r.requireApprovalIf.roleDiffersFromTarget) {
        failures.push({ rule: 'targetRoles', detail: 'role differs from target roles' });
      } else {
        passes.push({ rule: 'targetRoles', detail: 'target role check waived' });
      }
    }
  }

  // Excluded companies
  if (r.excludedCompanies.length > 0) {
    const company = (job?.company || '').toLowerCase();
    const excluded = r.excludedCompanies.some((c) => company.includes(c.toLowerCase()));
    if (excluded) {
      failures.push({ rule: 'excludedCompany', detail: `${job?.company} is excluded` });
    } else {
      passes.push({ rule: 'excludedCompany', detail: 'not excluded' });
    }
  }

  // Daily limit
  if (r.dailyLimit > 0 && dailyCount != null) {
    if (dailyCount < r.dailyLimit) {
      passes.push({ rule: 'dailyLimit', detail: `${dailyCount}/${r.dailyLimit} used today` });
    } else {
      failures.push({ rule: 'dailyLimit', detail: `daily limit reached: ${dailyCount}/${r.dailyLimit}` });
    }
  }

  const eligible = failures.length === 0;
  const decision = eligible ? 'READY_FOR_AUTOMATIC_APPLICATION' : 'MANUAL_APPROVAL_REQUIRED';

  return { eligible, passes, failures, decision };
}

/**
 * Format rule evaluation for display.
 */
export function formatEvaluation(evalResult) {
  const lines = [];
  for (const p of evalResult.passes) lines.push(`  \u2713 ${p.rule}: ${p.detail}`);
  for (const f of evalResult.failures) lines.push(`  \u2717 ${f.rule}: ${f.detail}`);
  return lines.join('\n');
}
