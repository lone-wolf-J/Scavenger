// Application answers store — reusable answers to common application questions.
// Answers are per-profile and persisted in the workspace. The user configures
// them once; the application engine fills them automatically.

export const COMMON_FIELDS = [
  { key: 'workAuthorization', label: 'Work authorization', type: 'select', options: ['US Citizen', 'Green Card', 'H1B Visa', 'OPT/CPT', 'Other', 'Prefer not to say'] },
  { key: 'yearsExperience', label: 'Years of experience', type: 'number' },
  { key: 'salaryExpectation', label: 'Salary expectation', type: 'number', prefix: '$' },
  { key: 'noticePeriod', label: 'Notice period', type: 'select', options: ['Immediate', '2 weeks', '1 month', '2 months', '3 months', 'Other'] },
  { key: 'willingToRelocate', label: 'Willing to relocate', type: 'select', options: ['Yes', 'No', 'Depends on location'] },
  { key: 'sponsorshipRequired', label: 'Requires sponsorship', type: 'select', options: ['Yes', 'No', 'Currently on valid visa'] },
  { key: 'linkedinUrl', label: 'LinkedIn URL', type: 'url' },
  { key: 'portfolioUrl', label: 'Portfolio URL', type: 'url' },
  { key: 'phone', label: 'Phone number', type: 'tel' },
  { key: 'email', label: 'Email address', type: 'email' },
  { key: 'githubUrl', label: 'GitHub URL', type: 'url' },
  { key: 'personalWebsite', label: 'Personal website', type: 'url' },
  { key: 'pronouns', label: 'Pronouns', type: 'text' },
  { key: 'startDate', label: 'Available start date', type: 'text' },
];

/**
 * Get stored answers for a profile.
 */
export function getAnswers(workspace, profileId) {
  if (!workspace || !profileId) return {};
  return workspace.applicationAnswers?.[profileId] || {};
}

/**
 * Save answers for a profile (merge-safe).
 */
export function setAnswers(workspace, profileId, answers) {
  if (!workspace || !profileId) return workspace;
  workspace.applicationAnswers = workspace.applicationAnswers || {};
  workspace.applicationAnswers[profileId] = {
    ...(workspace.applicationAnswers[profileId] || {}),
    ...answers,
  };
  return workspace;
}

/**
 * Match stored answers against a list of form fields.
 * Returns { filled, unknown } where filled = {fieldKey: answer} and unknown = [fieldKey].
 */
export function matchAnswers(fields, storedAnswers) {
  const filled = {};
  const unknown = [];
  for (const field of fields) {
    const key = field.key || field.id || field.label;
    const answer = storedAnswers[key] || storedAnswers[field.label];
    if (answer !== undefined && answer !== null && answer !== '') {
      filled[key] = String(answer);
    } else {
      unknown.push(key);
    }
  }
  return { filled, unknown };
}

/**
 * Get safe-to-auto-answer fields (no personal interpretation needed).
 */
export function getAutoFillableFields() {
  return COMMON_FIELDS.map((f) => f.key);
}

/**
 * Check if a field is safe to auto-fill (known factual, no interpretation).
 */
export function isAutoFillable(fieldKey) {
  return getAutoFillableFields().includes(fieldKey);
}
