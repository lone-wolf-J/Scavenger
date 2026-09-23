import 'dotenv/config';
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export async function evaluateWithOpenRouter({
  root,
  jdText,
  model,
  baseUrl,
  apiKey,
  timeoutMs = 300000,
}) {
  if (!jdText?.trim()) {
    throw new Error("No Job Description provided.");
  }

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const sharedPath = join(root, "modes", "_shared.md");
  const ofertaPath = join(root, "modes", "oferta.md");
  const cvPath = join(root, "cv.md");
  const profilePath = join(root, "config", "profile.yml");

  for (const [label, file] of [
    ["modes/_shared.md", sharedPath],
    ["modes/oferta.md", ofertaPath],
    ["cv.md", cvPath],
    ["config/profile.yml", profilePath],
  ]) {
    if (!existsSync(file)) {
      throw new Error(`Required file missing: ${label}`);
    }
  }

  const sharedContext = readFileSync(sharedPath, "utf8").trim();
  const ofertaLogic = readFileSync(ofertaPath, "utf8").trim();
  const cvContent = readFileSync(cvPath, "utf8").trim();
  const profileYml = readFileSync(profilePath, "utf8").trim();

  const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

=== SHARED RULES ===
${sharedContext}

=== EVALUATION METHODOLOGY ===
${ofertaLogic}

=== USER CV ===
${cvContent}

=== USER PROFILE ===
${profileYml}

=== JOB DESCRIPTION ===
${jdText}

IMPORTANT OPERATING RULES FOR THIS SESSION
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - Block D (Comp research): use training-data salary estimates; note them as estimates.
   - Block G (Legitimacy): analyze JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the application, not by you.
2. Generate Blocks A through G in full.
3. At the very end, output this exact machine-readable block:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---`;

  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;

  const host = new URL(baseUrl).hostname;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: `JOB DESCRIPTION TO EVALUATE:\n\n${jdText}`,
        },
      ],
      stream: false,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API error: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const evaluationText = data.choices?.[0]?.message?.content?.trim();

  if (!evaluationText) {
    throw new Error(`OpenRouter returned an empty response from ${model}.`);
  }

  const summaryStart = evaluationText.indexOf("---SCORE_SUMMARY---");
  const summaryEnd = evaluationText.indexOf("---END_SUMMARY---");

  const summaryBody =
    summaryStart >= 0 && summaryEnd > summaryStart
      ? evaluationText.slice(
          summaryStart + "---SCORE_SUMMARY---".length,
          summaryEnd
        )
      : "";

  const extract = (key, fallback = "unknown") => {
    if (!summaryBody) return fallback;

    const line = summaryBody
      .split(/\r?\n/)
      .find((entry) => entry.trimStart().startsWith(`${key}:`));

    return line
      ? line.slice(line.indexOf(":") + 1).trim()
      : fallback;
  };

  return {
    evaluationText,
    company: extract("COMPANY"),
    role: extract("ROLE"),
    score: extract("SCORE", "?"),
    archetype: extract("ARCHETYPE"),
    legitimacy: extract("LEGITIMACY"),
    model,
    host,
    usage: data.usage ?? null,
  };
}




