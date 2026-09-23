// Application web service — server-side bridge between Next.js routes and
// the application domain modules. Handles path resolution, workspace access,
// and repository binding.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { careerOpsRoot } from '@/lib/career-ops';
import { scavengerPaths } from './core';
import { getWorkspace, saveWorkspaceState } from './workspace';

const APPLICATIONS_FILE = 'applications.json';

function applicationsPath(): string {
  return path.join(scavengerPaths().dir, APPLICATIONS_FILE);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _repo: any = null;

async function appRepo() {
  if (_repo) return _repo;
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(path.join(careerOpsRoot(), 'lib', 'repositories', 'application-repository.mjs')).href);
  _repo = mod.openApplicationRepository(applicationsPath());
  return _repo;
}

export async function listApplications(opts: { profileId?: string; status?: string } = {}) {
  const repo = await appRepo();
  return repo.list(opts);
}

export async function getApplication(applicationId: string) {
  const repo = await appRepo();
  return repo.get(applicationId);
}

export async function createApplicationFromJob({ jobId, profileId }: { jobId: string; profileId: string }) {
  const repo = await appRepo();
  const workspace = await getWorkspace();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profile = (workspace.profiles || []).find((p: any) => p.id === profileId);
  if (!profile) return { ok: false, reason: 'profile not found' };

  // Load job from the job store
  const jobRepoMod = await import(/* webpackIgnore: true */ pathToFileURL(path.join(careerOpsRoot(), 'lib', 'repositories', 'job-repository.mjs')).href);
  const jobs = jobRepoMod.openJobRepository(path.join(scavengerPaths().dir, 'job-store.json'));
  const job = jobs.get(jobId);
  if (!job) return { ok: false, reason: 'job not found' };

  // Detect application method
  const appMod = await import(/* webpackIgnore: true */ pathToFileURL(path.join(careerOpsRoot(), 'lib', 'application.mjs')).href);
  const method = appMod.detectApplicationMethod(job);

  // Check duplicate
  const existing = repo.findAny(jobId, profileId);
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

  const app = appMod.createApplication({
    jobId,
    profileId,
    profileName: profile.name || '',
    resumeName: profile.profile?.resumeName || '',
    method,
    mode: 'MANUAL',
    jobTitle: job.title || '',
    company: job.company || '',
    location: job.location || '',
    url: job.url || '',
    applyUrl: job.applyUrl || job.url || '',
  });

  repo.create(app);
  return { ok: true, application: app };
}

export async function transitionApplicationStatus(applicationId: string, toStatus: string, { detail = '' } = {}) {
  const repo = await appRepo();
  return repo.transition(applicationId, toStatus, { detail });
}

export async function getApplicationMetrics() {
  const repo = await appRepo();
  return repo.metrics();
}

export async function getApplicationAnswers(profileId: string) {
  const workspace = await getWorkspace();
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(path.join(careerOpsRoot(), 'lib', 'application-answers.mjs')).href);
  return mod.getAnswers(workspace, profileId);
}

export async function setApplicationAnswers(profileId: string, answers: Record<string, string>) {
  const workspace = await getWorkspace();
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(path.join(careerOpsRoot(), 'lib', 'application-answers.mjs')).href);
  mod.setAnswers(workspace, profileId, answers);
  saveWorkspaceState(workspace);
  return { ok: true };
}

export async function getApplicationRules(profileId: string) {
  const workspace = await getWorkspace();
  return workspace.applicationRules?.[profileId] || null;
}

export async function setApplicationRules(profileId: string, rules: Record<string, unknown>) {
  const workspace = await getWorkspace();
  workspace.applicationRules = workspace.applicationRules || {};
  workspace.applicationRules[profileId] = rules;
  saveWorkspaceState(workspace);
  return { ok: true };
}
