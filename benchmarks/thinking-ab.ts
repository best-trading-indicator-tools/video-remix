/** Opt-in paid comparison. Run each mode in its own process; never changes saved jobs.
 * npx tsx benchmarks/thinking-ab.ts --run-deepseek --mode thinking [--env /private/.env]
 * Add --workspace /path/to/video-remixer to include up to eight saved edit transcripts.
 * Prints only case hashes, outcomes, latency and numeric usage. No source text or reasoning.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { EditPlan, Transcript } from "../shared/types.js";

const args = process.argv.slice(2);
const argument = (name: string) => args[args.indexOf(name) + 1];
const mode = args.includes("--mode") ? argument("--mode") : "";
if (!args.includes("--run-deepseek") || !["fast", "thinking"].includes(mode)) {
  throw new Error("Paid benchmark requires --run-deepseek --mode fast|thinking");
}
if (args.includes("--env")) process.loadEnvFile(argument("--env"));
process.env.DEEPSEEK_THINKING = mode === "thinking" ? "true" : "false";
const { editorialAIConfigured, editorialModel } = await import("../server/editorial-provider.js");
const { deepseekEditorialReviewer } = await import("../server/editorial-model.js");
const { reviewEditorialPlan } = await import("../server/editorial-review.js");
const { editorialSmokeFixtures } = await import("./editorial-smoke.js");
const { writeCreativePlan } = await import("../server/intelligence.js");
const { discoverSourceIdeas } = await import("../server/source-ideas.js");
const { matchBrollDescriptions } = await import("../server/broll-ai.js");
if (!editorialAIConfigured()) throw new Error("Configure the existing DeepSeek key and enable Auto AI");

type Case = { id: string; plan: EditPlan; transcript: Transcript; expected?: string; expectedIssues?: string[] };
const brollOnly = args.includes("--broll-only");
const cases: Case[] = brollOnly ? [] : editorialSmokeFixtures(true);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceHashes = new Set<string>(), editHashes = new Set<string>();
if (!brollOnly && args.includes("--workspace")) {
  const db = new DatabaseSync(path.join(argument("--workspace"), "data", "remixer.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT data FROM records WHERE collection = 'jobs' ORDER BY id").all();
    for (const row of rows) {
      const job = JSON.parse(String(row.data));
      if (job.status !== "completed" || !job.editPlan || !job.sourceTranscript?.segments?.length) continue;
      const editHash = hash({ plan: job.editPlan, transcript: job.sourceTranscript });
      if (editHashes.has(editHash) || editHashes.size >= 8) continue;
      editHashes.add(editHash); sourceHashes.add(hash(job.sourceTranscript));
      cases.push({ id: `saved-${hash(job.id).slice(0, 12)}`, plan: job.editPlan, transcript: job.sourceTranscript });
    }
  } finally { db.close(); }
}

type Call = { status?: number; mode: string; seconds: number; input?: number; cacheHit?: number; output?: number; reasoning?: number };
let calls: Call[] = [], totalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) !== "https://api.deepseek.com/chat/completions" || ++totalCalls > 140)
    throw new Error("Benchmark request budget exceeded");
  const start = Date.now(), body = JSON.parse(String(init?.body));
  const call: Call = { mode: body.thinking?.type, seconds: 0 }; calls.push(call);
  try {
    const response = await originalFetch(input, init); call.status = response.status;
    if (response.ok) {
      // Consume the clone immediately. Keep only numeric usage, never model text.
      const raw = await response.clone().json();
      const usage = raw.usage || {};
      const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
      call.input = finite(usage.prompt_tokens); call.cacheHit = finite(usage.prompt_cache_hit_tokens);
      call.output = finite(usage.completion_tokens); call.reasoning = finite(usage.completion_tokens_details?.reasoning_tokens);
    }
    return response;
  } finally { call.seconds = Number(((Date.now() - start) / 1000).toFixed(2)); }
};
const signal = new AbortController().signal;
const results: Record<string, unknown>[] = [];
async function measure(id: string, task: () => Promise<Record<string, unknown>>) {
  calls = []; const start = Date.now();
  let outcome: Record<string, unknown>;
  try { outcome = await task(); }
  catch { outcome = { failed: true }; }
  const row = { id, ...outcome, seconds: Number(((Date.now() - start) / 1000).toFixed(2)), calls };
  results.push(row); console.log(JSON.stringify({ mode, ...row }));
}
const temporary = await mkdtemp(path.join(os.tmpdir(), "thinking-benchmark-"));
try {
  for (const item of cases) await measure(item.id, async () => {
    const report = await reviewEditorialPlan({ plan: item.plan, transcript: item.transcript,
      aiEnabled: true, signal, reviewer: deepseekEditorialReviewer });
    const detected = report.issues.filter(issue => issue.origin === "semantic").map(issue => issue.code);
    return { task: "editorial", status: report.status, semanticCoverage: report.coverage.semantic,
      detected, failure: report.failure?.code, ...(item.expected ? { expected: item.expected,
        expectedIssues: item.expectedIssues, matched: report.status === item.expected &&
          item.expectedIssues!.every(code => detected.includes(code)) } : {}) };
  });
  if (!brollOnly) await measure("authored-complete-excerpt-selection", async () => {
    const candidates = [
      { start: 0, end: 4, text: "That is why it helps.", context: { before: "Which camera support helps with shake?", after: "" } },
      { start: 8, end: 18, text: "A tripod keeps a stationary camera steady. Use a timer to avoid shaking it when pressing the shutter." },
      { start: 22, end: 27, text: "There are two things you need to do before pressing the shutter.", context: { before: "", after: "First, lock the tripod. Second, set the timer." } },
    ];
    const result = await writeCreativePlan(candidates, 1, "en", false, signal);
    return { task: "selection", matched: result?.windowIndex === 1, selectedIndex: result?.windowIndex,
      packaged: result?.hookRewritten ?? false };
  });
  if (!brollOnly) await measure("complete-idea-discovery", async () => {
    const discovery = cases.find(item => item.id.startsWith("saved-")) ?? cases[0]!;
    const result = await discoverSourceIdeas({ transcript: discovery.transcript,
      sourceDuration: discovery.plan.sourceDuration, targetDuration: Math.min(30, discovery.plan.sourceDuration),
      cacheDir: temporary, signal });
    return { task: "discovery", analyzed: result.analyzed, fullCoverage: result.coverage.full,
      anchoredCandidates: result.candidates.length, candidateWindows: result.candidates.map(({ start, end }) => ({ start, end })) };
  });
  const communication = "Sending a good morning text to a friend is a powerful way to check in. Feeling cared for helps us feel part of the tribe.";
  const gorilla = { assetId: "clip-1", description: "A large gorilla walks through a forest and sits on a branch." };
  const texting = { assetId: "clip-2", description: "A person types a greeting in a messaging conversation on a smartphone." };
  const light = { assetId: "clip-1", description: "A hand flips a wall switch and a room light goes dark." };
  const laptop = { assetId: "clip-2", description: "A person works at a laptop in an office late at night." };
  const scenarios = [
    { id: "morning-text-not-wildlife", text: communication, clips: [gorilla, texting], expected: ["clip-2"] },
    { id: "no-suitable-communication-shot", text: communication, clips: [gorilla], expected: [] },
    { id: "switch-off-after-work", text: "I couldn't switch off after work. Even late at night I was still answering emails on my laptop.",
      clips: [light, laptop], expected: ["clip-2"] },
    { id: "search-intent-is-not-observation", text: communication,
      clips: [{ ...gorilla, searchIntent: { momentIndex: 0, visual: "person texting a friend", reason: "Supports human communication" } }], expected: [] },
  ];
  for (const item of scenarios) await measure(`authored-broll-${item.id}`, async () => {
    const result = await matchBrollDescriptions({ model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
      apiKey: process.env.DEEPSEEK_API_KEY!.trim(), signal, targetCount: 1, briefLimit: 3,
      moments: [{ momentIndex: 0, start: 0, end: 8, text: item.text }], clips: item.clips });
    const parsed = z.array(z.object({ momentIndex: z.literal(0), assetId: z.enum(item.clips.map(clip => clip.assetId) as [string, ...string[]]),
      confidence: z.number().min(0).max(1), reason: z.string().min(1).max(180) }).strict()).safeParse(result.matches);
    const selected = parsed.success ? parsed.data.filter(match => match.confidence >= 0.75).map(match => match.assetId).sort() : [];
    return { task: "broll-semantic-matching", matched: parsed.success && JSON.stringify(selected) === JSON.stringify(item.expected),
      selected, expected: item.expected, limitation: "Authored visual descriptions; does not evaluate frame recognition or crop quality." };
  });
  console.log(JSON.stringify({ summary: { mode, model: editorialModel(), savedEdits: editHashes.size,
    distinctSavedTranscripts: sourceHashes.size, totalCalls, cases: results.length,
    authoredMatched: results.filter(row => row.matched === true).length,
    authoredEvaluated: results.filter(row => typeof row.matched === "boolean").length,
    limitation: "Text/plan checks only. Saved edits lack independent human labels. This is not a visual-quality or creator-acceptance benchmark." } }));
} finally { globalThis.fetch = originalFetch; await rm(temporary, { recursive: true, force: true }); }
