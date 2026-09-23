// Workspace + profile operations for routes and server components.
// Every function below delegates to lib/scavenger-workspace.mjs and
// lib/profile-review.mjs — this file only binds workspace paths.

import fs from "node:fs";
import path from "node:path";
import { loadDomainLib, scavengerPaths } from "./core";

export type ScavengerProfile = {
  id: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile: any;
  signalsHash?: string;
  state?: string;
  sourceDocumentIds?: string[];
  createdAt?: string;
  updatedAt?: string;
  confirmedAt?: string;
};

async function wsLib() {
  return loadDomainLib("scavenger-workspace");
}

function readWorkspace() {
  const { workspace } = scavengerPaths();
  return { paths: scavengerPaths(), workspace };
}

export async function getWorkspace() {
  const ws = await wsLib();
  const { workspace: workspacePath } = scavengerPaths();
  return ws.loadWorkspace(workspacePath);
}

export async function saveWorkspaceState(state: unknown) {
  const ws = await wsLib();
  const { workspace: workspacePath } = scavengerPaths();
  ws.saveWorkspace(state, workspacePath);
}

export async function listProfiles(): Promise<ScavengerProfile[]> {
  const state = await getWorkspace();
  return state.profiles || [];
}

export async function createManualProfile(input: {
  name?: string;
  targetRoles?: string[];
  seniority?: string;
  skills?: string[];
  technologies?: string[];
  industries?: string[];
  domains?: string[];
  functionalAreas?: string[];
  yearsExperience?: number | null;
  location?: string;
  workplace?: string;
  employment?: string;
  compMin?: number | null;
  exclusions?: string[];
}) {
  const ws = await wsLib();
  const cp = await loadDomainLib("career-profile");
  const state = await getWorkspace();
  const profile = cp.normalizeCareerProfile({
    targetRoles: input.targetRoles || [],
    seniority: input.seniority || "",
    skills: input.skills || [],
    technologies: input.technologies || [],
    industries: input.industries || [],
    domains: input.domains || [],
    functionalAreas: input.functionalAreas || [],
    yearsExperience: input.yearsExperience ?? null,
    locationPrefs: input.location ? { raw: [input.location] } : {},
    workplacePrefs: input.workplace ? [input.workplace] : [],
    employmentPrefs: input.employment ? [input.employment] : [],
    compensationPrefs: { min: input.compMin ?? 0 },
    exclusions: input.exclusions || [],
  });
  const record = ws.addProfile(state, { name: input.name, profile, sourceDocumentIds: [] });
  const { workspace: workspacePath } = scavengerPaths();
  ws.saveWorkspace(state, workspacePath);
  return record;
}

/** Upload bytes → extract → signals → draft profile (no persistence of text). */
export async function ingestDocument(filename: string, bytes: Buffer) {
  const ext = path.extname(filename).toLowerCase();
  const { documents } = scavengerPaths();
  fs.mkdirSync(documents, { recursive: true });
  const safe = `${Date.now()}-${path.basename(filename).replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
  const savedPath = path.join(documents, safe);
  fs.writeFileSync(savedPath, bytes);
  const rio = await loadDomainLib("resume-io");
  const doc = rio.extractDocumentText({ path: savedPath });
  if (doc.quality === "unparseable") {
    return { ok: false as const, error: doc.warnings.join("; ") || "could not parse document" };
  }
  const rs = await loadDomainLib("resume-signals");
  const signals = rs.extractResumeSignals(doc.text, { source: safe });
  const cp = await loadDomainLib("career-profile");
  const profile = cp.fromSignals(signals);
  const ws = await wsLib();
  const state = await getWorkspace();
  const record = ws.addDocument(state, { name: filename, format: doc.format, quality: doc.quality });
  const draft = ws.saveDraft(state, { signals, profile, documentId: record.id });
  const { workspace: workspacePath } = scavengerPaths();
  ws.saveWorkspace(state, workspacePath);
  return {
    ok: true as const,
    draftId: draft.id,
    documentId: record.id,
    quality: doc.quality,
    warnings: doc.warnings,
    signals,
    profile,
    inferredTargets: cp.inferTargetRoles(signals),
  };
}

export async function getDraft(draftId: string) {
  const state = await getWorkspace();
  return state.drafts?.[draftId] || null;
}

export async function confirmDraft(
  draftId: string,
  opts: { corrections?: unknown[]; adopt?: string[]; name?: string },
) {
  const ws = await wsLib();
  const pr = await loadDomainLib("profile-review");
  const state = await getWorkspace();
  const draft = state.drafts?.[draftId];
  if (!draft) return { ok: false as const, error: "draft not found (it may already be confirmed)" };
  const { profile: corrected, applied, rejected } = pr.applyCorrections(draft.profile, opts.corrections || []);
  const confirmed = pr.confirmProfile(corrected, { adoptInferred: opts.adopt || [] });
  // Content hash for provenance — resume text itself is never persisted.
  const crypto = await import("node:crypto");
  const signalsHash = crypto.createHash("sha256").update(JSON.stringify(draft.signals)).digest("hex");
  const record = ws.addProfile(state, {
    name: opts.name,
    profile: confirmed,
    signalsHash,
    sourceDocumentIds: draft.documentId ? [draft.documentId] : [],
  });
  ws.dropDraft(state, draftId);
  const { workspace: workspacePath } = scavengerPaths();
  ws.saveWorkspace(state, workspacePath);
  return { ok: true as const, profile: record, applied, rejected };
}

export async function patchProfile(
  id: string,
  patch: { name?: string; state?: string; action?: string; profile?: unknown },
) {
  const ws = await wsLib();
  const state = await getWorkspace();
  if (patch.action === "duplicate") {
    const copy = ws.duplicateProfile(state, id);
    if (!copy) return { ok: false as const, error: "profile not found" };
    const { workspace: workspacePath } = scavengerPaths();
    ws.saveWorkspace(state, workspacePath);
    return { ok: true as const, profile: copy };
  }
  const updated = ws.updateProfile(state, id, patch);
  if (!updated) return { ok: false as const, error: "profile not found" };
  const { workspace: workspacePath } = scavengerPaths();
  ws.saveWorkspace(state, workspacePath);
  return { ok: true as const, profile: updated };
}

export async function deleteProfileById(id: string) {
  const ws = await wsLib();
  const state = await getWorkspace();
  const ok = ws.deleteProfile(state, id);
  if (!ok) return { ok: false as const, error: "profile not found" };
  const { workspace: workspacePath } = scavengerPaths();
  ws.saveWorkspace(state, workspacePath);
  return { ok: true as const };
}

export async function setSelection(ids: string[]) {
  const ws = await wsLib();
  const state = await getWorkspace();
  const selected = ws.selectProfiles(state, ids);
  const { workspace: workspacePath } = scavengerPaths();
  ws.saveWorkspace(state, workspacePath);
  return selected;
}
