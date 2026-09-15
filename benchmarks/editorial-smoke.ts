/** Opt-in semantic smoke, never part of CI: npx tsx benchmarks/editorial-smoke.ts --run-local
 * Four authored text fixtures; no user media, cloud calls, model downloads or retries.
 * Results are observations on these examples, not human acceptance or model accuracy.
 */
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS, type EditPlan, type Transcript } from "../shared/types.js";
import { config } from "../server/config.js";
import { intelligenceAvailable } from "../server/intelligence.js";
import { editorialReplySchema, localEditorialReviewer } from "../server/editorial-model.js";
import { reviewEditorialPlan } from "../server/editorial-review.js";

function speech(text: string, start: number): Transcript["segments"][number] {
  const words = text.split(" ").map((word, index) => ({ word, start: Number((start + index * 0.32).toFixed(3)),
    end: Number((start + index * 0.32 + 0.27).toFixed(3)) }));
  return { start, end: words.at(-1)!.end, text, words };
}
function fixture(id: string, segments: Transcript["segments"], cuts: EditPlan["cuts"], hook: string,
  expected: "pass" | "needs-review", expectedIssues: string[], captions: EditPlan["captions"] = []) {
  const sourceDuration = segments.at(-1)!.end + 0.3;
  const outputDuration = Number(cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0).toFixed(3));
  const plan: EditPlan = { version: 1, revision: 1, sourceId: `authored-${id}`, sourceDuration, outputDuration,
    createdAt: "2026-09-15T00:00:00Z", settings: { ...DEFAULT_SETTINGS, speed: 1, volume: 1, muted: false,
      hookText: hook, hookDuration: 2, segments: cuts, audioId: null, subtitleId: null },
    cuts, captions, visuals: [], media: [], narration: false };
  return { id, expected, expectedIssues, transcript: { language: "en", duration: sourceDuration, segments } as Transcript, plan };
}
export function editorialSmokeFixtures() {
  const camera = speech("A tripod keeps the camera steady. Use a timer to avoid shaking it when you press the shutter.", 0);
  const tripod = speech("Using a tripod reduces camera shake.", 0);
  const caveat = speech("It does not prevent a moving subject from blurring.", tripod.end + 0.4);
  const bin = speech("The blue sorting bin holds paper.", 0);
  const limitation = speech("Put clean paper in it, but keep wet paper out.", bin.end + 0.4);
  const archive = speech("The archive is not open on Sundays.", 0);
  const monday = speech("It opens on Mondays.", archive.end + 0.4);
  return [
    fixture("complete-camera-advice", [camera], [{ start: 0, end: camera.end + 0.3 }], "Keep your camera steady", "pass", []),
    fixture("omitted-caveat-universal-hook", [tripod, caveat], [{ start: 0, end: tripod.end + 0.15 }],
      "Tripods prevent all blur", "needs-review", ["hook-supported", "meaning-preserved"]),
    fixture("retained-paper-qualification-captions", [bin, limitation], [{ start: 0, end: limitation.end + 0.3 }],
      "Clean paper goes in the blue bin", "pass", [], [
        { id: "bin", start: bin.start, end: bin.end, text: bin.text },
        { id: "limitation", start: limitation.start, end: limitation.end, text: limitation.text },
      ]),
    fixture("removed-archive-negation", [archive, monday], [
      { start: 0, end: archive.words[2]!.end + 0.025 },
      { start: archive.words[4]!.start - 0.025, end: archive.end + 0.1 },
    ], "Archive opening days", "needs-review", ["meaning-preserved"]),
  ];
}

export async function runEditorialSmoke() {
  const endpoint = new URL(config.ollamaUrl);
  const localEndpoint = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) &&
    ["http:", "https:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password;
  if (!localEndpoint || !config.localAI) {
    console.log(JSON.stringify({ available: false, reason: "A local enabled Ollama endpoint is required", calls: 0 }));
    return;
  }
  const available = await intelligenceAvailable();
  console.log(JSON.stringify({ model: config.ollamaModel, available, localEndpoint }));
  if (!available) return;
  let calls = 0;
  for (const item of editorialSmokeFixtures()) {
    const start = Date.now();
    let reply: unknown, failure: string | undefined;
    const report = await reviewEditorialPlan({ plan: item.plan, transcript: item.transcript, localAI: true,
      signal: new AbortController().signal, reviewer: async (request, signal) => {
        if (++calls > 4) throw new Error("Authored smoke call budget exhausted");
        try { reply = await localEditorialReviewer(request, signal); return reply; }
        catch (error) {
          // Never print provider messages, stacks, endpoint URLs or environment values.
          failure = error instanceof Error && error.name === "ZodError" ? "invalid-structured-response" :
            error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timed-out-or-aborted" : "provider-or-evidence-validation-failed";
          throw error;
        }
      } });
    const parsed = editorialReplySchema.safeParse(reply);
    const detected = report.issues.filter(issue => issue.origin === "semantic").map(issue => issue.code);
    console.log(JSON.stringify({ fixture: item.id, expected: item.expected, expectedIssues: item.expectedIssues,
      actual: report.status, semanticCoverage: report.coverage.semantic, detected, failure,
      expectedStatusMatched: item.expected === report.status,
      missedExpectedIssues: item.expectedIssues.filter(code => !detected.includes(code)),
      seconds: Number(((Date.now() - start) / 1000).toFixed(2)),
      findings: parsed.success ? parsed.data.checks.map(({ check, verdict, explanation }) => ({ check, verdict, explanation })) : [] }));
  }
  console.log(JSON.stringify({ calls, limitation: "Four authored textual examples; this does not measure human acceptance, audio, visuals or platform eligibility." }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--run-local")) await runEditorialSmoke();
  else console.log(JSON.stringify({ usage: "npx tsx benchmarks/editorial-smoke.ts --run-local", calls: 0,
    fixtures: editorialSmokeFixtures().map(({ id, expected, expectedIssues }) => ({ id, expected, expectedIssues })) }, null, 2));
}
