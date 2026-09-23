// JSON file repository helper — the persistence mechanics every entity
// repository shares. Atomic tmp+rename writes; strict reads (malformed →
// caller-supplied empty, never a merged or half-parsed object).

import { existsSync } from 'fs';
import { atomicWriteJson, readJsonStrict } from '../atomic-write.mjs';

/**
 * @param {string} filePath
 * @param {() => object} emptyFactory
 * @param {(parsed: object) => object|null} [normalize] - validate/migrate; null rejects
 */
export function createJsonRepository(filePath, emptyFactory, normalize = null) {
  return {
    path: filePath,
    load() {
      if (!filePath || !existsSync(filePath)) return emptyFactory();
      const parsed = readJsonStrict(filePath);
      if (!parsed) return emptyFactory();
      if (typeof normalize === 'function') {
        const out = normalize(parsed);
        if (!out) return emptyFactory();
        return out;
      }
      return parsed;
    },
    save(state) {
      atomicWriteJson(filePath, state);
    },
  };
}
