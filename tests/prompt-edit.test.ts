import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type EditPlan, type Transcript } from "../shared/types.js";
import { applyEditPlanChanges } from "../server/edit-plan.js";
import { PromptEditError, proposePromptEdit } from "../server/prompt-edit.js";

const makePlan = (): EditPlan => ({
  version: 1, revision: 3, sourceId: "private-source", sourceDuration: 30, outputDuration: 10,
  createdAt: "2026-09-15T12:00:00.000Z",
  settings: { ...DEFAULT_SETTINGS, hookText: "Dosage units explained", hookDuration: 3, trimEnd: 15,
    segments: [{ start: 0, end: 5 }, { start: 10, end: 15 }],
    callouts: [{ text: "A supporting explanation", start: 6, end: 7 }],
  },
  cuts: [{ start: 0, end: 5 }, { start: 10, end: 15, focalPoint: { x: 0.4, y: 0.5 } }],
  captions: [
    { id: "caption-1", start: 1, end: 2, text: "The first corrected phrase." },
    { id: "caption-2", start: 6, end: 7, text: "Micrograms and milligrams differ." },
  ],
  visuals: [
    { id: "visual-1", mediaId: "media:one", start: 6, end: 8, sourceStart: 1, locked: true, enabled: true, reason: "Supports the example" },
    { id: "visual-2", mediaId: "media:two", start: 2, end: 3, sourceStart: 0, locked: true, enabled: false },
  ],
  media: [
    { id: "media:one", name: "/private/original/Pipette.mp4", kind: "broll", duration: 8, url: "/api/edits/media/secret-one", attribution: { provider: "Pixabay", creator: "Private creator", url: "https://pixabay.com/videos/id-123/" }, stock: { providerId: "123", rendition: "private-rendition", contentHash: "private-hash", retrievedAt: "today", licenseUrl: "https://example.com/license" } },
    { id: "media:two", name: "Alternative shot.mp4", kind: "broll", duration: 8 },
    { id: "audio:one", name: "private-narration.wav", kind: "audio", duration: 10, url: "/private/audio" },
  ],
  narration: false,
});
const complete = (reply: unknown) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }] });
const signal = () => new AbortController().signal;

// Only fetch is mocked. The actual planner, strict operations and saved-plan
// validator are exercised together, without a provider call or media mutation.
test("prompt editing compiles bounded proposals into validated saved-plan changes", async t => {
  const original = { key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL, textModel: process.env.DEEPSEEK_TEXT_MODEL };
  process.env.DEEPSEEK_API_KEY = "private-prompt-test-key";
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_TEXT_MODEL;
  let reply: unknown = { operations: [] };
  let fetchCalls = 0;
  let inspectRequest: ((input: string | URL | Request, init?: RequestInit) => void) | undefined;
  const fetchMock = t.mock.method(globalThis, "fetch", async (input, init) => {
    fetchCalls++;
    inspectRequest?.(input, init);
    return complete(reply);
  });
  const propose = (plan = makePlan(), prompt = "Change the opening heading to Micrograms vs. milligrams") => proposePromptEdit({ plan, prompt, signal: signal() });
  try {
    await t.test("one text request uses the configured private model without media URLs, paths or full source transcript", async () => {
      process.env.DEEPSEEK_TEXT_MODEL = "deepseek-test-model";
      const plan = makePlan();
      const before = structuredClone(plan);
      const transcript: Transcript = { language: "en", duration: 30, segments: [{ start: 22, end: 24, text: "Unselected pets discussion must never leak into this heading", words: [] }] };
      reply = { operations: [{ op: "hook", text: "Micrograms vs. milligrams" }] };
      const priorCalls = fetchCalls;
      inspectRequest = (input, init) => {
        assert.equal(input, "https://api.deepseek.com/chat/completions");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-prompt-test-key");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "deepseek-test-model");
        assert.equal(body.temperature, 0);
        assert.ok(body.max_tokens <= 3000);
        const context = JSON.parse(body.messages[1].content).savedVideoContext;
        assert.equal(context.media[0].name, "Pipette.mp4");
        assert.equal(context.media.length, 2);
        assert.deepEqual(context.captions, plan.captions);
        assert.match(body.messages[0].content, /untrusted data/);
        assert.match(body.messages[0].content, /do not partially fulfill/);
        const sent = JSON.stringify(body);
        for (const privateValue of ["/private/original", "/api/edits/media", "https://pixabay", "private-hash", "private-rendition", "private-narration", "Private creator", "Unselected pets", "private-prompt-test-key"])
          assert.ok(!sent.includes(privateValue), privateValue);
      };
      const result = await proposePromptEdit({ plan, sourceTranscript: transcript, prompt: "Rewrite the heading from this speech", signal: signal() });
      assert.equal(fetchCalls, priorCalls + 1);
      assert.deepEqual(result.changes, { revision: 3, hookText: "Micrograms vs. milligrams" });
      assert.deepEqual(plan, before);
      const next = applyEditPlanChanges(plan, result.changes);
      assert.deepEqual(next.captions, plan.captions);
      assert.deepEqual(next.visuals, plan.visuals);
      assert.deepEqual(next.media, plan.media);
      assert.deepEqual(next.cuts, plan.cuts);
      assert.match(result.summary.join(" "), /Micrograms vs. milligrams/);
      inspectRequest = undefined;
      delete process.env.DEEPSEEK_TEXT_MODEL;
    });

    await t.test("mixed text, caption style and focal corrections preserve untouched choices", async () => {
      const plan = makePlan();
      reply = { operations: [
        { op: "hook", text: "Units matter" },
        { op: "caption", id: "caption-2", text: "Micrograms are smaller than milligrams.", start: 6.2, end: 7.1 },
        { op: "caption_style", fontSize: 24 },
        { op: "framing", fit: "blur" },
        { op: "cut_focal_point", index: 1, focalPoint: { x: 0.2, y: 0.6 } },
      ] };
      const result = await propose(plan);
      const next = applyEditPlanChanges(plan, result.changes);
      assert.deepEqual(next.captions[0], plan.captions[0]);
      assert.equal(next.captions[1]!.text, "Micrograms are smaller than milligrams.");
      assert.equal(next.captions[1]!.start, 6.2);
      assert.deepEqual(next.visuals, plan.visuals);
      assert.equal(next.settings.captionStyle?.fontSize, 24);
      assert.equal(next.settings.captionStyle?.bottomPercent, 100 * 24 / 288);
      assert.equal(next.settings.fit, "blur");
      assert.deepEqual(next.cuts[0], plan.cuts[0]);
      assert.deepEqual(next.cuts[1]!.focalPoint, { x: 0.2, y: 0.6 });
      assert.match(result.summary.join(" "), /1 caption/);
      assert.match(result.summary.join(" "), /6\.2–7\.1s “Micrograms are smaller than milligrams\.”/);
    });

    await t.test("global framing updates source-cut overrides while preserving supporting shots", async () => {
      reply = { operations: [{ op: "framing", focalPoint: { x: 0.8, y: 0.4 } }] };
      const plan = makePlan(), result = await propose(plan);
      const next = applyEditPlanChanges(plan, result.changes);
      assert.deepEqual(next.settings.focalPoint, { x: 0.8, y: 0.4 });
      assert.equal(next.cuts[0]!.focalPoint, undefined);
      assert.deepEqual(next.cuts[1]!.focalPoint, { x: 0.8, y: 0.4 });
      assert.deepEqual(next.visuals, plan.visuals);
    });

    await t.test("output trimming maps across source cuts and playback speed, retiming existing choices", async () => {
      const plan = makePlan();
      plan.settings.speed = 2;
      plan.outputDuration = 5;
      plan.captions = [{ id: "caption-1", start: 1, end: 2, text: "Keep my corrected phrase" }, { id: "caption-2", start: 3, end: 3.5, text: "Second phrase" }];
      plan.visuals = [{ ...plan.visuals[0]!, start: 3, end: 4 }];
      plan.settings.callouts = [{ text: "Keep this", start: 3, end: 3.5 }];
      reply = { operations: [{ op: "trim", start: 1, end: 4 }, { op: "caption", id: "caption-2", text: "A corrected second phrase" }] };
      const result = await propose(plan, "Keep seconds 1 through 4 and correct the second phrase");
      assert.deepEqual(result.changes.cuts, [{ start: 2, end: 5 }, { start: 10, end: 13, focalPoint: plan.cuts[1]!.focalPoint }]);
      const next = applyEditPlanChanges(plan, result.changes);
      assert.equal(next.outputDuration, 3);
      assert.deepEqual(next.captions[0], { ...plan.captions[0]!, start: 0, end: 1 });
      assert.deepEqual(next.captions[1], { ...plan.captions[1]!, text: "A corrected second phrase", start: 2, end: 2.5 });
      assert.deepEqual(next.visuals, [{ ...plan.visuals[0]!, start: 2, end: 3 }]);
      assert.deepEqual(next.settings.callouts, [{ text: "Keep this", start: 2, end: 2.5 }]);
      assert.equal(result.changes.visuals, undefined, "Automatic retiming is not rewritten as a manual shot change");
      assert.match(result.summary.join(" "), /source seconds 2–5, then 10–13/);
    });

    await t.test("explicit source sequences use local source speech to retime captions", async () => {
      const plan = makePlan();
      const sourceTranscript: Transcript = { language: "en", duration: 30, segments: [{ start: 16, end: 17, text: "A new example", words: [{ start: 16, end: 16.2, word: "A" }, { start: 16.2, end: 16.5, word: "new" }, { start: 16.5, end: 17, word: "example" }] }] };
      reply = { operations: [{ op: "cuts", cuts: [{ start: 0, end: 5 }, { start: 15, end: 20 }] }] };
      const result = await proposePromptEdit({ plan, prompt: "Use source seconds 0–5 and 15–20", sourceTranscript, signal: signal() });
      const next = applyEditPlanChanges(plan, result.changes, sourceTranscript);
      assert.deepEqual(next.captions[0], plan.captions[0]);
      assert.equal(next.captions[1]!.text, "A new example");
      assert.equal(next.captions[1]!.start, 6);
    });

    await t.test("uncaptioned heading context includes only speech inside selected cuts", async () => {
      const plan = makePlan();
      plan.captions = [];
      const sourceTranscript: Transcript = { language: "en", duration: 30, segments: [
        { start: 1, end: 2, text: "Units in the selected speech", words: [] },
        { start: 7, end: 8, text: "Unselected pets discussion", words: [] },
        { start: 11, end: 12, text: "More selected units discussion", words: [] },
        { start: 14, end: 17, text: "A partial segment must not leak", words: [] },
      ] };
      inspectRequest = (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const context = JSON.parse(body.messages[1].content).savedVideoContext;
        assert.equal(context.selectedSpeech, "Units in the selected speech More selected units discussion");
        assert.ok(!String(init?.body).includes("Unselected pets"));
        assert.ok(!String(init?.body).includes("partial segment"));
      };
      reply = { operations: [{ op: "hook", text: "Units explained" }] };
      const result = await proposePromptEdit({ plan, prompt: "Rewrite the heading from the selected speech", sourceTranscript, signal: signal() });
      assert.equal(result.changes.hookText, "Units explained");
      inspectRequest = undefined;
      plan.narration = true;
      const narrated = await proposePromptEdit({ plan, prompt: "Rewrite the heading", sourceTranscript, signal: signal() });
      assert.deepEqual(narrated.changes, { revision: 3 });
      assert.match(narrated.clarification!, /no selected speech/);
    });

    await t.test("a heading without speech context requires the user's literal wording and blocks mixed partial changes", async () => {
      const plan = makePlan();
      plan.captions = [];
      reply = { operations: [{ op: "hook", text: "An invented fact" }, { op: "framing", fit: "blur" }] };
      const ungrounded = await propose(plan, "Improve the heading and use a blurred background");
      assert.deepEqual(ungrounded.changes, { revision: 3 });
      assert.deepEqual(ungrounded.summary, []);
      assert.match(ungrounded.clarification!, /exact heading/);
      reply = { operations: [{ op: "hook", text: "My own heading" }] };
      assert.equal((await propose(plan, "Use the heading My own heading")).changes.hookText, "My own heading");
      reply = { operations: [{ op: "hook", text: "" }] };
      assert.equal((await propose(plan, "Remove the heading")).changes.hookText, "");
    });

    await t.test("a targeted stock replacement unlocks only that shot; enabling/disabling preserves locks", async () => {
      const plan = makePlan();
      reply = { operations: [{ op: "visual", id: "visual-1", mediaId: "media:two", start: 5, end: 7, sourceStart: 2, focalPoint: { x: 0.3, y: 0.5 } }] };
      const replacement = await propose(plan);
      const next = applyEditPlanChanges(plan, replacement.changes);
      assert.equal(next.visuals[0]!.locked, false);
      assert.equal(next.visuals[0]!.mediaId, "media:two");
      assert.deepEqual(next.visuals[1], plan.visuals[1]);
      assert.match(replacement.summary.join(" "), /unlock this shot/);
      assert.match(replacement.summary.join(" "), /Alternative shot\.mp4/);
      reply = { operations: [{ op: "visual", id: "visual-1", enabled: false }, { op: "visual", id: "visual-2", enabled: true }] };
      const toggled = applyEditPlanChanges(plan, (await propose(plan)).changes);
      assert.equal(toggled.visuals[0]!.locked, true);
      assert.equal(toggled.visuals[0]!.enabled, false);
      assert.equal(toggled.visuals[1]!.locked, true);
      assert.equal(toggled.visuals[1]!.enabled, true);
    });

    await t.test("caption removals are explicit and preserve footage and narration", async () => {
      const plan = makePlan();
      plan.narration = true;
      plan.audioMediaId = "audio:one";
      for (const ids of [["caption-2"], "all"]) {
        reply = { operations: [{ op: "remove_captions", ids }] };
        const result = await propose(plan);
        const next = applyEditPlanChanges(plan, result.changes);
        assert.equal(next.captions.length, ids === "all" ? 0 : 1);
        assert.deepEqual(next.visuals, plan.visuals);
        assert.equal(next.audioMediaId, plan.audioMediaId);
        assert.equal(next.narration, true);
      }
    });

    await t.test("a stock refresh is gated and cannot silently combine with manual shot edits", async () => {
      reply = { operations: [{ op: "refresh_broll" }] };
      await assert.rejects(propose(), /Searching again is unavailable/);
      const result = await proposePromptEdit({ plan: makePlan(), prompt: "Find B-roll again", signal: signal(), canRefreshBroll: true });
      assert.deepEqual(result.changes, { revision: 3, refreshBroll: true });
      assert.match(result.summary.join(" "), /when you render/);
      reply = { operations: [{ op: "refresh_broll" }, { op: "visual", id: "visual-1", enabled: true }] };
      await assert.rejects(proposePromptEdit({ plan: makePlan(), prompt: "Refresh and edit B-roll", signal: signal(), canRefreshBroll: true }), /separately/);
    });

    await t.test("additional B-roll retains existing shots and composes pending counts", async () => {
      reply = { operations: [{ op: "add_broll", count: 2 }] };
      const before = makePlan();
      const added = await proposePromptEdit({ plan: before, prompt: "I need 2 more brolls", signal: signal(), canRefreshBroll: true });
      assert.deepEqual(added.changes, { revision: 3, refreshBroll: true, preserveBroll: true, brollCount: 3 });
      assert.deepEqual(applyEditPlanChanges(before, added.changes).visuals, before.visuals);
      const again = await proposePromptEdit({ plan: before, prompt: "two more", signal: signal(), canRefreshBroll: true, pendingBrollCount: 3 });
      assert.equal(again.changes.brollCount, 5);
      await assert.rejects(proposePromptEdit({ plan: before, prompt: "more", signal: signal(), canRefreshBroll: true, pendingBrollCount: 9 }), /exceed 10/);
      await assert.rejects(proposePromptEdit({ plan: before, prompt: "more", signal: signal() }), /Configure a stock provider/);
      reply = { operations: [{ op: "refresh_broll", total: 4 }] };
      const total = await proposePromptEdit({ plan: before, prompt: "4 total", signal: signal(), canRefreshBroll: true });
      assert.equal(total.changes.brollCount, 4);
      assert.equal(total.changes.preserveBroll, undefined);
    });

    await t.test("ambiguous or unsupported mixed requests never partially apply the supported part", async () => {
      reply = { operations: [{ op: "hook", text: "This must not be applied" }], clarification: "Changing playback speed is not supported here. Should I only change the heading?" };
      const result = await propose(makePlan(), "Change the heading and double playback speed");
      assert.deepEqual(result.changes, { revision: 3 });
      assert.deepEqual(result.summary, []);
      assert.match(result.clarification!, /not supported/);
      reply = { operations: [{ op: "volume", value: 2 }] };
      await assert.rejects(propose(), (error: unknown) => error instanceof PromptEditError && error.status === 502 && /unsupported/.test(error.message));
      reply = { operations: [], summary: ["Volume doubled"] };
      await assert.rejects(propose(), /unsupported or invalid/);
    });

    await t.test("matching values return an understandable no-op and no artificial changed fields", async () => {
      reply = { operations: [{ op: "hook", text: "Dosage units explained" }, { op: "caption", id: "caption-1", text: "The first corrected phrase." }, { op: "framing", fit: "crop", focalPoint: { x: 0.5, y: 0.5 } }] };
      const plan = makePlan();
      delete plan.cuts[1]!.focalPoint;
      const result = await propose(plan);
      assert.deepEqual(result.changes, { revision: 3 });
      assert.deepEqual(result.summary, []);
      assert.match(result.clarification!, /already match/);
    });

    await t.test("invalid IDs, values, timing and unexpected fields reject the entire proposal", async () => {
      const invalidOperations = [
        { op: "caption", id: "missing", text: "Wrong" },
        { op: "caption", id: "caption-1", text: "<b>Markup</b>" },
        { op: "caption", id: "caption-1", end: 11 },
        { op: "caption", id: "caption-1", start: 6.5, end: 7.5 },
        { op: "caption", id: "caption-1", end: 0.5 },
        { op: "remove_captions", ids: ["missing"] },
        { op: "caption_style", fontSize: 41 },
        { op: "caption_style", bottomPercent: 0 },
        { op: "framing", focalPoint: { x: 2, y: 0.5 } },
        { op: "cut_focal_point", index: 99, focalPoint: { x: 0, y: 0 } },
        { op: "trim", start: 5, end: 4 },
        { op: "trim", end: 11 },
        { op: "trim", start: -1 },
        { op: "cuts", cuts: [{ start: 0, end: 31 }] },
        { op: "cuts", cuts: [{ start: 0, end: 0.01 }] },
        { op: "visual", id: "missing", enabled: false },
        { op: "visual", id: "visual-1", mediaId: "missing-media" },
        { op: "visual", id: "visual-1", mediaId: "audio:one" },
        { op: "visual", id: "visual-1", sourceStart: 7 },
        { op: "visual", id: "visual-1", end: 6.2 },
        { op: "visual", id: "visual-1", end: 11 },
        { op: "visual", id: "visual-1", locked: false },
        { op: "hook", text: "Fine", settings: { volume: 2 } },
      ];
      for (const operation of invalidOperations) {
        const plan = makePlan(), before = structuredClone(plan);
        reply = { operations: [{ op: "hook", text: "A valid part must not be applied" }, operation] };
        await assert.rejects(propose(plan), PromptEditError, JSON.stringify(operation));
        assert.deepEqual(plan, before);
      }
      reply = { operations: [{ op: "trim", end: 8 }, { op: "cuts", cuts: [{ start: 0, end: 5 }] }] };
      await assert.rejects(propose(), /one trim/);
      reply = { operations: [{ op: "trim", start: 3 }, { op: "caption", id: "caption-1", text: "Excluded caption" }] };
      await assert.rejects(propose(), /unavailable after these cuts/);
      reply = { operations: [{ op: "visual", id: "visual-2", enabled: true, start: 6, end: 7 }] };
      await assert.rejects(propose(), /cannot overlap/);
    });

    await t.test("narrated duration remains locked and equal-duration footage changes preserve narration", async () => {
      const plan = makePlan();
      plan.narration = true;
      plan.audioMediaId = "audio:one";
      reply = { operations: [{ op: "trim", start: 1 }] };
      await assert.rejects(propose(plan), /Narration audio is locked/);
      reply = { operations: [{ op: "cuts", cuts: [{ start: 5, end: 15 }] }] };
      const next = applyEditPlanChanges(plan, (await propose(plan)).changes);
      assert.equal(next.outputDuration, 10);
      assert.equal(next.audioMediaId, "audio:one");
      assert.deepEqual(next.captions, plan.captions);
      assert.deepEqual(next.visuals, plan.visuals);
    });

    await t.test("oversized context, invalid prompts and missing configuration fail before any provider request", async () => {
      const callsBefore = fetchCalls;
      const large = makePlan();
      large.captions = Array.from({ length: 301 }, (_, i) => ({ id: `cue-${i}`, start: i, end: i + 0.5, text: "Words" }));
      await assert.rejects(propose(large), (error: unknown) => error instanceof PromptEditError && error.status === 413);
      large.captions = large.captions.slice(0, 200).map(cue => ({ ...cue, text: "x".repeat(500) }));
      await assert.rejects(propose(large), /too much caption text/);
      for (const prompt of ["", " ", "x".repeat(2001), "unsafe\u0000prompt"]) await assert.rejects(propose(makePlan(), prompt), /plain text/);
      delete process.env.DEEPSEEK_API_KEY;
      await assert.rejects(propose(), (error: unknown) => error instanceof PromptEditError && error.status === 503 && /DEEPSEEK_API_KEY/.test(error.message));
      process.env.DEEPSEEK_API_KEY = "private-prompt-test-key";
      process.env.DEEPSEEK_MODEL = "https://unexpected-provider.example";
      await assert.rejects(propose(), /model is invalid/);
      delete process.env.DEEPSEEK_MODEL;
      assert.equal(fetchCalls, callsBefore);
    });

    await t.test("bad provider JSON and failures expose no provider diagnostics or credentials", async () => {
      for (const response of [
        Response.json({ choices: [{ finish_reason: "stop", message: { content: "{broken" } }] }),
        Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }),
        new Response("private provider body with private-prompt-test-key", { status: 401 }),
      ]) {
        fetchMock.mock.mockImplementationOnce(async () => response);
        await assert.rejects(propose(), (error: unknown) => error instanceof PromptEditError && error.status === 502 && !error.message.includes("private-prompt-test-key"));
      }
    });

    await t.test("cancellation before or during a provider request is propagated without a proposal", async () => {
      const before = new AbortController();
      before.abort();
      const callsBefore = fetchCalls;
      await assert.rejects(proposePromptEdit({ plan: makePlan(), prompt: "Change the heading", signal: before.signal }), { name: "AbortError" });
      assert.equal(fetchCalls, callsBefore);
      const during = new AbortController();
      fetchMock.mock.mockImplementationOnce(async (_input, init) => {
        during.abort();
        init?.signal?.throwIfAborted();
        return complete({ operations: [] });
      });
      await assert.rejects(proposePromptEdit({ plan: makePlan(), prompt: "Change the heading", signal: during.signal }), { name: "AbortError" });
    });
  } finally {
    fetchMock.mock.restore();
    for (const [name, value] of Object.entries({ DEEPSEEK_API_KEY: original.key, DEEPSEEK_MODEL: original.model, DEEPSEEK_TEXT_MODEL: original.textModel })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
