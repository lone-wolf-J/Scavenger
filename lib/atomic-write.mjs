// Atomic persistence — tmp-file + rename so a crash mid-write can never
// leave a half-written store behind. Malformed JSON on load is rejected
// (empty default) rather than merged or "repaired".

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
}

/** Parse JSON strictly: objects/arrays pass, anything else (or corrupt text) → null. */
export function readJsonStrict(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
