// Profile repository — user career profiles. Delegates identity/selection
// rules to scavenger-workspace.mjs; every record carries userId (local seam:
// 'local' today, real ids later) and cross-user access always misses.

import { createJsonRepository } from './json-file.mjs';
import {
  emptyWorkspace, addProfile, getProfile, updateProfile,
  duplicateProfile, deleteProfile,
} from '../scavenger-workspace.mjs';

function normalizeWorkspace(parsed) {
  if (typeof parsed !== 'object' || !parsed) return null;
  return {
    version: 1,
    userId: typeof parsed.userId === 'string' ? parsed.userId : 'local',
    documents: Array.isArray(parsed.documents) ? parsed.documents : [],
    drafts: parsed.drafts && typeof parsed.drafts === 'object' ? parsed.drafts : {},
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
    selectedProfileIds: Array.isArray(parsed.selectedProfileIds) ? parsed.selectedProfileIds : [],
  };
}

const owned = (rec, userId) => !!rec && (rec.userId || 'local') === userId;

export function openProfileRepository(workspacePath, userId = 'local') {
  const repo = createJsonRepository(workspacePath, () => emptyWorkspace(userId), normalizeWorkspace);
  const mutate = (fn) => {
    const state = repo.load();
    const out = fn(state);
    repo.save(state);
    return out;
  };
  const mine = (state) => (state.profiles || []).filter((p) => owned(p, userId));
  return {
    path: workspacePath,
    userId,
    load: () => repo.load(),
    list: () => mine(repo.load()),
    active: () => mine(repo.load()).filter((p) => p.state === 'active'),
    get: (id) => {
      const found = getProfile(repo.load(), id);
      return owned(found, userId) ? found : null;
    },
    create: (input) => mutate((s) => {
      const rec = addProfile(s, input);
      rec.userId = userId;
      return rec;
    }),
    update: (id, patch, opts) => mutate((s) => {
      if (!owned(getProfile(s, id), userId)) return null;
      return updateProfile(s, id, patch, opts);
    }),
    duplicate: (id, opts) => mutate((s) => {
      if (!owned(getProfile(s, id), userId)) return null;
      const copy = duplicateProfile(s, id, opts);
      if (copy) copy.userId = userId;
      return copy;
    }),
    remove: (id) => mutate((s) => {
      if (!owned(getProfile(s, id), userId)) return false;
      return deleteProfile(s, id);
    }),
    select: (ids) => mutate((s) => {
      const mineIds = new Set(mine(s).filter((p) => p.state === 'active').map((p) => p.id));
      s.selectedProfileIds = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => mineIds.has(id)))];
      return s.selectedProfileIds;
    }),
    selectAll: () => mutate((s) => {
      s.selectedProfileIds = mine(s).filter((p) => p.state === 'active').map((p) => p.id);
      return s.selectedProfileIds;
    }),
    selected: () => {
      const s = repo.load();
      const mineIds = new Set(mine(s).map((p) => p.id));
      return (s.selectedProfileIds || []).filter((id) => mineIds.has(id));
    },
  };
}
