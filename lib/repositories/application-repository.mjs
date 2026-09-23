// Application repository — persistence layer for the application domain model.
// Uses the same JSON-file repository pattern as match-repository and job-repository.

import fs from 'node:fs';
import path from 'node:path';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Open an application repository at the given path.
 * @param {string} storePath - path to applications.json
 * @returns {ApplicationRepository}
 */
export function openApplicationRepository(storePath) {
  return new ApplicationRepository(storePath);
}

class ApplicationRepository {
  constructor(filePath) {
    this._path = filePath;
    this._state = null;
  }

  get path() { return this._path; }

  _ensure() {
    if (!this._state) {
      this._state = loadJson(this._path) || { version: 1, applications: {} };
      if (!this._state.applications) this._state.applications = {};
    }
    return this._state;
  }

  save(state) {
    this._state = state || this._state;
    atomicWrite(this._path, this._state);
  }

  /** List all applications, optionally filtered. */
  list({ profileId, status, jobId, limit } = {}) {
    const state = this._ensure();
    let apps = Object.values(state.applications);
    if (profileId) apps = apps.filter((a) => a.profileId === profileId);
    if (status) apps = apps.filter((a) => a.status === status);
    if (jobId) apps = apps.filter((a) => a.jobId === jobId);
    apps.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    if (limit) apps = apps.slice(0, limit);
    return apps;
  }

  /** Get a single application by ID. */
  get(applicationId) {
    const state = this._ensure();
    return state.applications[applicationId] || null;
  }

  /** Find active (non-terminal) application for a job+profile combination. */
  findActive(jobId, profileId) {
    const state = this._ensure();
    return Object.values(state.applications).find(
      (a) => a.jobId === jobId && a.profileId === profileId && !isTerminalStatus(a.status),
    ) || null;
  }

  /** Find any application (including terminal) for dedup check. */
  findAny(jobId, profileId) {
    const state = this._ensure();
    return Object.values(state.applications).find(
      (a) => a.jobId === jobId && a.profileId === profileId,
    ) || null;
  }

  /** Create a new application. */
  create(application) {
    const state = this._ensure();
    if (state.applications[application.applicationId]) {
      throw new Error(`application ${application.applicationId} already exists`);
    }
    state.applications[application.applicationId] = application;
    this.save(state);
    return application;
  }

  /** Update an application (partial merge). */
  update(applicationId, patch) {
    const state = this._ensure();
    const existing = state.applications[applicationId];
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    state.applications[applicationId] = updated;
    this.save(state);
    return updated;
  }

  /** Transition an application to a new status with audit log. */
  transition(applicationId, toStatus, { detail = '' } = {}) {
    const state = this._ensure();
    const app = state.applications[applicationId];
    if (!app) return { ok: false, reason: 'application not found' };
    if (!canTransitionStatus(app.status, toStatus)) {
      return { ok: false, reason: `cannot transition from ${app.status} to ${toStatus}` };
    }
    const now = new Date().toISOString();
    const updated = {
      ...app,
      previousStatus: app.status,
      status: toStatus,
      updatedAt: now,
      auditLog: [...(app.auditLog || []), { status: toStatus, at: now, detail }],
    };
    if (toStatus === 'SUBMITTED') updated.submittedAt = now;
    if (toStatus === 'IN_PROGRESS') updated.lastAttemptAt = now;
    if (toStatus === 'FAILED') {
      updated.failureCount = (app.failureCount || 0) + 1;
      updated.failureReason = detail || 'unknown error';
    }
    if (toStatus === 'ACTION_REQUIRED') {
      updated.failureReason = detail || 'human intervention needed';
    }
    state.applications[applicationId] = updated;
    this.save(state);
    return { ok: true, application: updated };
  }

  /** Count applications by status (for daily limits). */
  countToday({ profileId, status = 'SUBMITTED' } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const state = this._ensure();
    return Object.values(state.applications).filter((a) => {
      if (profileId && a.profileId !== profileId) return false;
      if (a.status !== status) return false;
      const created = (a.createdAt || '').slice(0, 10);
      const submitted = (a.submittedAt || '').slice(0, 10);
      return created === today || submitted === today;
    }).length;
  }

  /** Get metrics. */
  metrics() {
    const state = this._ensure();
    const apps = Object.values(state.applications);
    const byStatus = {};
    for (const a of apps) {
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    }
    return { total: apps.length, byStatus };
  }
}

const TERMINAL = new Set(['REJECTED', 'WITHDRAWN', 'HIRED']);

function isTerminalStatus(status) {
  return TERMINAL.has(status);
}

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
  REJECTED:       [],
  WITHDRAWN:      [],
  INTERVIEW:      ['OFFER', 'REJECTED', 'WITHDRAWN'],
  OFFER:          ['HIRED', 'REJECTED', 'WITHDRAWN'],
  HIRED:          [],
};

function canTransitionStatus(from, to) {
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}
