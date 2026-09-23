#!/usr/bin/env node

/**
 * profile.mjs — Career Profile lifecycle CLI (thin interface over libs).
 *
 *   node profile.mjs extract <resume.pdf|resume.docx|resume.txt> [--json]
 *   node profile.mjs review <signals.json>                      # printable review
 *   node profile.mjs confirm --signals <f> [--corrections <f>] [--adopt a,b] --id <id>
 *   node profile.mjs list                                       # persisted profiles
 *   node profile.mjs match --profile <id.json> --jobs <jobs.json> [--top N]
 *
 * Privacy: extraction logs COUNTS, never resume contents. Persisted
 * profiles contain model fields only (no email/phone/raw text) — see
 * redactForLogs(). Signals files are user input; the CLI never persists
 * them unless --keep-signals is passed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { extractDocumentText } from './lib/resume-io.mjs';
import { extractResumeSignals } from './lib/resume-signals.mjs';
import { fromSignals, inferTargetRoles } from './lib/career-profile.mjs';
import { renderReview, applyCorrections, confirmProfile } from './lib/profile-review.mjs';
import { matchJob } from './lib/matcher.mjs';

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

const DATA_ROOT = getCareerOpsRoot();
const PROFILES_DIR = process.env.CAREER_OPS_PROFILES_DIR || path.join(DATA_ROOT, 'data', 'profiles');

/** Mask PII for logs: keep domain-neutral structure, drop identity. */
export function redactForLogs(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[phone]');
  }
  if (Array.isArray(obj)) return obj.map(redactForLogs);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/^(email|phone)$/i.test(k)) out[k] = '[redacted]';
      else out[k] = redactForLogs(v);
    }
    return out;
  }
  return obj;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''));
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

async function popplerExtractor(ext) {
  if (ext !== '.pdf') return null;
  try {
    const intake = await import('./intake.mjs');
    return intake.detectPdfExtractor() || null;
  } catch {
    return null;
  }
}

export async function cmdExtract(file, { json = false } = {}) {
  const ext = path.extname(file).toLowerCase();
  const doc = extractDocumentText({ path: file, pdfExtractor: await popplerExtractor(ext) });
  if (doc.quality === 'unparseable') {
    console.error(`unparseable: ${doc.warnings.join('; ')}`);
    process.exitCode = 1;
    return null;
  }
  if (doc.quality === 'partial') console.error(`note: partial extraction — ${doc.warnings.join('; ')}`);
  const signals = extractResumeSignals(doc.text, { source: file });
  // Log counts only — never resume contents.
  console.error(`extracted: ${signals.currentRoles.length} current, ${signals.previousRoles.length} previous roles, `
    + `${signals.skills.length} skills, ${signals.technologies.length} technologies`);
  if (json) process.stdout.write(JSON.stringify(signals, null, 2) + '\n');
  return signals;
}

export function cmdReview(signals) {
  const profile = fromSignals(signals);
  const { text } = renderReview(profile, signals);
  console.log(text);
  const inferred = inferTargetRoles(signals).filter((t) => t.kind === 'inferred');
  if (inferred.length) console.error(`\n${inferred.length} inferred target role(s) need confirmation (see above).`);
  return profile;
}

export function cmdConfirm(signals, { corrections = [], adopt = [], id = 'default', keepSignals = false } = {}) {
  const draft = fromSignals(signals);
  const { profile: corrected, applied, rejected } = applyCorrections(draft, corrections);
  for (const r of rejected) console.error(`correction rejected: ${r.op} — ${r.reason}`);
  const confirmed = confirmProfile(corrected, { adoptInferred: adopt });
  ensureDir(PROFILES_DIR);
  const outPath = path.join(PROFILES_DIR, `${id}.json`);
  const record = {
    id,
    profile: confirmed,
    signalsHash: sha256(JSON.stringify(signals)),
    ...(keepSignals ? { signals } : {}),
    confirmedAt: confirmed.confirmedAt,
    history: [{ at: confirmed.confirmedAt, applied, adopted: confirmed.adoptedInferredTargets }],
  };
  writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  console.log(`profile "${id}" confirmed → ${outPath} (${applied.length} correction(s) applied)`);
  return record;
}

export function cmdList() {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

export function cmdMatch(profileRecord, jobs, { top = 20 } = {}) {
  const profile = profileRecord.profile || profileRecord;
  const id = profileRecord.id || 'default';
  const results = (Array.isArray(jobs) ? jobs : [])
    .map((job) => matchJob(job, profile, { profileId: id }))
    .sort((a, b) => b.score - a.score);
  for (const r of results.slice(0, top)) {
    const job = jobs.find((j) => matchJobId(j) === r.jobId);
    console.log(`${r.score}/100 [${r.band.label}] ${job?.company || '?'} — ${job?.title || '?'}`);
    for (const reason of r.reasons.slice(0, 3)) console.log(`    + ${reason}`);
    for (const pen of r.penalties.slice(0, 2)) console.log(`    - ${pen}`);
  }
  return results;
}

function matchJobId(job) {
  return job.id || `${job.source}:${job.url || job.title}`;
}

if (isMainModule(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };
  if (cmd === 'extract' && rest[0]) {
    await cmdExtract(rest[0], { json: rest.includes('--json') });
  } else if (cmd === 'review' && rest[0]) {
    cmdReview(readJson(rest[0]));
  } else if (cmd === 'confirm') {
    const signals = readJson(flag('--signals'));
    const corrections = flag('--corrections') ? readJson(flag('--corrections')) : [];
    const adopt = (flag('--adopt') || '').split(',').map((s) => s.trim()).filter(Boolean);
    cmdConfirm(signals, { corrections, adopt, id: flag('--id') || 'default', keepSignals: rest.includes('--keep-signals') });
  } else if (cmd === 'list') {
    console.log(cmdList().join('\n'));
  } else if (cmd === 'match') {
    const prof = readJson(flag('--profile'));
    const jobs = readJson(flag('--jobs'));
    cmdMatch(prof, jobs, { top: Number(flag('--top')) || 20 });
  } else {
    console.log('Usage: node profile.mjs <extract|review|confirm|list|match> [...]');
    process.exitCode = 2;
  }
}
