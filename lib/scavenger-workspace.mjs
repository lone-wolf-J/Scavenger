// Scavenger workspace — the local-first user abstraction (Phase 4 §1).
//
// Conceptually: User { documents[], profiles[], selectedProfileIds[] }.
// No auth: one local user (userId 'local', forward-compatible with tenancy).
// Profiles and history live in separate files so a user's documents and
// profiles can never become shared job-intelligence data.
//
// Workspace shape:
//   { version: 1, userId: 'local',
//     documents: [{id, name, format, quality, addedAt, source}],
//     drafts: { [draftId]: {signals, profile, documentId, createdAt} },
//     profiles: [{id, name, profile, signalsHash, state, sourceDocumentIds,
//                 createdAt, updatedAt, confirmedAt}],
//     selectedProfileIds: [] }
// Profile state: 'active' | 'archived'. Documents store metadata only —
// resume text is transient (extraction input), never persisted here.

import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { atomicWriteJson, readJsonStrict } from './atomic-write.mjs';

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function emptyWorkspace(userId = 'local') {
  return { version: 1, userId, documents: [], drafts: {}, profiles: [], selectedProfileIds: [] };
}

export function loadWorkspace(workspacePath) {
  if (!workspacePath || !existsSync(workspacePath)) return emptyWorkspace();
  const parsed = readJsonStrict(workspacePath); // malformed → empty, never merged
  if (parsed && !Array.isArray(parsed)) {
    return {
      version: 1,
      userId: typeof parsed.userId === 'string' ? parsed.userId : 'local',
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      drafts: parsed.drafts && typeof parsed.drafts === 'object' ? parsed.drafts : {},
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      selectedProfileIds: Array.isArray(parsed.selectedProfileIds) ? parsed.selectedProfileIds : [],
    };
  }
  return emptyWorkspace();
}

export function saveWorkspace(workspace, workspacePath) {
  atomicWriteJson(workspacePath, workspace);
}

export function addDocument(workspace, { name, format, quality, now = Date.now() } = {}) {
  const doc = {
    id: uid('doc'),
    name: String(name || 'untitled'),
    format: String(format || 'unknown'),
    quality: String(quality || 'unknown'),
    addedAt: new Date(now).toISOString(),
  };
  workspace.documents.push(doc);
  return doc;
}

export function saveDraft(workspace, { signals, profile, documentId = null, now = Date.now() }) {
  const id = uid('draft');
  workspace.drafts[id] = {
    id, signals, profile, documentId,
    createdAt: new Date(now).toISOString(),
  };
  return workspace.drafts[id];
}

export function dropDraft(workspace, draftId) {
  if (workspace.drafts[draftId]) { delete workspace.drafts[draftId]; return true; }
  return false;
}

function defaultProfileName(profile) {
  const cur = (profile?.currentRoles || [])[0];
  if (cur) return cur;
  const tgt = (profile?.targetRoles || [])[0];
  if (tgt) return tgt;
  return 'Custom Profile';
}

/**
 * Persist a confirmed profile. Editing one profile never touches another:
 * each record is an independent deep copy.
 */
export function addProfile(workspace, { name, profile, signalsHash = '', sourceDocumentIds = [], now = Date.now() }) {
  const stamp = new Date(now).toISOString();
  const record = {
    id: uid('prof'),
    name: String(name || defaultProfileName(profile)),
    profile: JSON.parse(JSON.stringify(profile || {})),
    signalsHash,
    state: 'active',
    sourceDocumentIds: [...sourceDocumentIds],
    createdAt: stamp,
    updatedAt: stamp,
    confirmedAt: stamp,
  };
  workspace.profiles.push(record);
  return record;
}

export function getProfile(workspace, id) {
  return (workspace.profiles || []).find((p) => p.id === id) || null;
}

export function activeProfiles(workspace) {
  return (workspace.profiles || []).filter((p) => p.state === 'active');
}

export function updateProfile(workspace, id, patch, { now = Date.now() } = {}) {
  const record = getProfile(workspace, id);
  if (!record) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) record.name = patch.name.trim();
  if (patch.profile && typeof patch.profile === 'object') {
    record.profile = JSON.parse(JSON.stringify(patch.profile));
  }
  if (patch.state === 'active' || patch.state === 'archived') record.state = patch.state;
  record.updatedAt = new Date(now).toISOString();
  return record;
}

export function duplicateProfile(workspace, id, { now = Date.now() } = {}) {
  const src = getProfile(workspace, id);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid('prof');
  copy.name = `${src.name} (copy)`;
  copy.state = 'active';
  const stamp = new Date(now).toISOString();
  copy.createdAt = stamp;
  copy.updatedAt = stamp;
  workspace.profiles.push(copy);
  return copy;
}

export function deleteProfile(workspace, id) {
  const i = (workspace.profiles || []).findIndex((p) => p.id === id);
  if (i < 0) return false;
  workspace.profiles.splice(i, 1);
  workspace.selectedProfileIds = (workspace.selectedProfileIds || []).filter((x) => x !== id);
  return true;
}

/** Select one, several, or all active profiles for a search. Unknown ids are dropped. */
export function selectProfiles(workspace, ids) {
  const active = new Set(activeProfiles(workspace).map((p) => p.id));
  workspace.selectedProfileIds = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => active.has(id)))];
  return workspace.selectedProfileIds;
}

export function selectAllProfiles(workspace) {
  workspace.selectedProfileIds = activeProfiles(workspace).map((p) => p.id);
  return workspace.selectedProfileIds;
}

export function workspaceFingerprint(workspace) {
  return createHash('sha256').update(JSON.stringify(workspace)).digest('hex').slice(0, 16);
}
