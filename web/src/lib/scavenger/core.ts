// Scavenger service layer — thin transport over the root domain libraries.
//
// ARCHITECTURE: WEB UI → this layer → SCAVENGER DOMAIN LIBRARIES → data.
// No business logic lives here: matching, extraction, dedup, scoring all
// run in <root>/lib/*.mjs (the Phase 1–3 source of truth), loaded at
// request time via dynamic import — the same ACL pattern as
// lib/core/text-key.ts (the core lives in the user's checkout, resolved via
// careerOpsRoot(), never a build dependency). Server-only (Node APIs).

import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMod = Record<string, any>;

const modCache = new Map<string, AnyMod>();

/** Load a root domain lib (<root>/lib/<name>.mjs), caching successes only. */
export async function loadDomainLib(name: string): Promise<AnyMod> {
  const file = path.join(careerOpsRoot(), "lib", `${name}.mjs`);
  const hit = modCache.get(file);
  if (hit) return hit;
  const mod = (await import(
    /* webpackIgnore: true */ pathToFileURL(file).href
  )) as AnyMod;
  modCache.set(file, mod);
  return mod;
}

/** Paths for the local-first stores (user layer, gitignored like data/). */
export function scavengerPaths() {
  const dir = path.join(careerOpsRoot(), "data", "scavenger");
  return {
    dir,
    workspace: path.join(dir, "workspace.json"),
    history: path.join(dir, "history.json"),
    documents: path.join(careerOpsRoot(), "documents", "scavenger"),
  };
}
