import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type RemixSettings } from "../shared/types.js";
import { proposeManualPrompt } from "../server/manual-prompt.js";
import { PromptEditError } from "../server/prompt-edit.js";

const source = { duration: 120, width: 1920, height: 1080, hasAudio: true };
const makeSettings = (): RemixSettings => ({
  ...DEFAULT_SETTINGS, gamma: 1.1, saturation: 0.9, contrast: 1.04,
  hookText: "A supplied heading", device: "Existing camera", stripMetadata: false,
  audioId: "f19bf15b-6204-4db5-aabd-a9e8548b4ec8", subtitleId: "ac17e658-d492-4a5b-b85a-5d46acbff8e4",
  callouts: [{ text: "Existing private callout", start: 1, end: 2 }],
});
const complete = (reply: unknown) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }] });

test("manual prompts compile private bounded settings proposals without mutating the workspace", async t => {
  const original = { key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL, textModel: process.env.DEEPSEEK_TEXT_MODEL };
  process.env.DEEPSEEK_API_KEY = "manual-prompt-private-test-key";
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_TEXT_MODEL;
  let reply: unknown = { patch: {} };
  let requests = 0;
  let inspectRequest: ((input: string | URL | Request, init?: RequestInit) => void) | undefined;
  const fetchMock = t.mock.method(globalThis, "fetch", async (input, init) => {
    requests++;
    inspectRequest?.(input, init);
    return complete(reply);
  });
  const propose = (settings = makeSettings(), prompt = "Make it warmer and keep source seconds 10 to 30") =>
    proposeManualPrompt({ settings, source, prompt, signal: new AbortController().signal });
  try {
    await t.test("mixed filters, speed, source trim and portrait format use one private text request", async () => {
      const settings = makeSettings(), before = structuredClone(settings);
      process.env.DEEPSEEK_TEXT_MODEL = "deepseek-manual-text";
      inspectRequest = (input, init) => {
        assert.equal(input, "https://api.deepseek.com/chat/completions");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer manual-prompt-private-test-key");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.temperature, 0);
        assert.equal(body.model, "deepseek-manual-text");
        assert.ok(body.max_tokens <= 3000);
        assert.equal(body.messages.length, 2);
        assert.match(body.messages[0].content, /untrusted data/);
        assert.match(body.messages[0].content, /Never partially fulfill/);
        const context = JSON.parse(body.messages[1].content);
        assert.deepEqual(context.attachments, { audio: true, captions: true });
        assert.deepEqual(context.source, source);
        assert.equal(context.currentSettings.gamma, 1.1);
        for (const privateValue of [settings.audioId!, settings.subtitleId!, "Existing camera", "Existing private callout", "manual-prompt-private-test-key", "/private/video.mp4"])
          assert.ok(!String(init?.body).includes(privateValue), privateValue);
      };
      reply = { patch: { temperature: 0.15, brightness: 0.04, speed: 1.25, trimStart: 10, trimEnd: 30, aspect: "9:16", resolution: "1080" } };
      const prior = requests;
      const result = await proposeManualPrompt({ settings, source: { ...source, filePath: "/private/video.mp4" } as typeof source, prompt: "Warm slightly, brighten, use 1.25x speed, source 10–30, vertical 1080p", signal: new AbortController().signal });
      assert.equal(requests, prior + 1);
      assert.equal(result.settings.temperature, 0.15);
      assert.equal(result.settings.gamma, 1.1);
      assert.equal(result.settings.saturation, 0.9);
      assert.equal(result.settings.contrast, 1.04);
      assert.equal(result.settings.audioId, settings.audioId);
      assert.equal(result.settings.subtitleId, settings.subtitleId);
      assert.equal(result.settings.device, settings.device);
      assert.equal(result.settings.stripMetadata, false);
      assert.deepEqual(result.settings.callouts, settings.callouts);
      assert.deepEqual(settings, before);
      assert.match(result.summary.join(" "), /Source seconds: 10–30/);
      assert.match(result.summary.join(" "), /1080 × 1920, 16 seconds/);
      inspectRequest = undefined;
      delete process.env.DEEPSEEK_TEXT_MODEL;
    });

    await t.test("every supported manual filter and output control is validated and summarized", async () => {
      reply = { patch: {
        speed: 0.75, volume: 0.8, muted: true, zoom: 1.1, saturation: 1.2, brightness: -0.02, contrast: 1.15,
        hue: 5, gamma: 1.2, temperature: -0.1, noise: 0.04, sharpness: 0.3, blend: 0.1, frameBlend: 0.05,
        mirror: true, aspect: "4:5", fit: "blur", resolution: "720", fps: "60", trimStart: 20, trimEnd: 35,
        hookText: "My exact heading", hookDuration: 5, normalizeAudio: true, qualityCleanup: true, autoMotion: true,
      } };
      const result = await propose(makeSettings(), "Use these settings and heading My exact heading");
      assert.equal(result.settings.frameBlend, 0.05);
      assert.equal(result.settings.blend, 0.1);
      assert.equal(result.settings.qualityCleanup, true);
      assert.equal(result.settings.fps, "60");
      assert.match(result.summary.join(" "), /Playback speed: 0\.75×/);
      assert.match(result.summary.join(" "), /Hue: 5°/);
      assert.match(result.summary.join(" "), /Frame smoothing: 0\.05s/);
      assert.match(result.summary.join(" "), /Local video cleanup: on/);
      assert.match(result.summary.join(" "), /720 × 900, 20 seconds/);
    });

    await t.test("a simple trim replaces inherited segments and clears their inherited time shift", async () => {
      const settings = makeSettings();
      settings.segments = [{ start: 10, end: 20 }, { start: 50, end: 60 }];
      settings.timeShift = 3;
      reply = { patch: { trimStart: 30, trimEnd: 40 } };
      const result = await propose(settings, "Use source seconds 30–40");
      assert.equal(result.settings.segments, undefined);
      assert.equal(result.settings.timeShift, 0);
      assert.equal(result.settings.trimStart, 30);
      assert.equal(result.settings.trimEnd, 40);
      assert.match(result.summary.join(" "), /Replace the previous sequence/);
      assert.match(result.summary.join(" "), /Source seconds: 30–40/);
      assert.deepEqual(settings.segments, [{ start: 10, end: 20 }, { start: 50, end: 60 }]);
    });

    await t.test("explicit source cuts preserve order and the chosen playback speed", async () => {
      const settings = makeSettings();
      settings.speed = 2;
      settings.timeShift = -2;
      reply = { patch: { segments: [{ start: 70, end: 80 }, { start: 10, end: 20, focalPoint: { x: 0.4, y: 0.6 } }] } };
      const result = await propose(settings, "Use source 70–80 followed by 10–20");
      assert.deepEqual(result.settings.segments, (reply as { patch: { segments: object[] } }).patch.segments);
      assert.equal(result.settings.speed, 2);
      assert.equal(result.settings.timeShift, 0);
      assert.match(result.summary.join(" "), /Source seconds: 70–80, then 10–20/);
      assert.match(result.summary.join(" "), /10 seconds/);
      assert.match(result.summary.join(" "), /Source cut 2 focal point: 40% across, 60% down/);
      reply = { patch: { segments: null } };
      const cleared = await propose(result.settings, "Clear the sequence");
      assert.equal(cleared.settings.segments, undefined);
      assert.match(cleared.summary.join(" "), /0–120/);
    });

    await t.test("time shift reports the renderer's actual clamped source interval", async () => {
      const settings = { ...makeSettings(), trimStart: 100, trimEnd: 118, speed: 2 };
      reply = { patch: { timeShift: 5 } };
      const result = await propose(settings, "Shift the selection forward five seconds");
      assert.equal(result.settings.timeShift, 5);
      assert.equal(result.settings.trimStart, 100);
      assert.equal(result.settings.trimEnd, 118);
      assert.match(result.summary.join(" "), /Source seconds: 102–120/);
      assert.match(result.summary.join(" "), /stops at the source edge/);
      assert.match(result.summary.join(" "), /9 seconds/);
      reply = { patch: { timeShift: -5 } };
      const backward = await propose({ ...settings, trimStart: 2, trimEnd: 20 }, "Shift backward five seconds");
      assert.match(backward.summary.join(" "), /Source seconds: 0–18/);
    });

    await t.test("caption and focal patches preserve untouched nested values and locked-in cut positions", async () => {
      const settings = makeSettings();
      settings.captionStyle = { fontSize: 18, bottomPercent: 15 };
      settings.focalPoint = { x: 0.3, y: 0.6 };
      settings.segments = [{ start: 10, end: 20, focalPoint: { x: 0.2, y: 0.4 } }, { start: 40, end: 45 }];
      reply = { patch: { captionStyle: { fontSize: 24 }, focalPoint: { x: 0.7 } } };
      const result = await propose(settings, "Make captions 24 and frame the right side");
      assert.deepEqual(result.settings.captionStyle, { fontSize: 24, bottomPercent: 15 });
      assert.deepEqual(result.settings.focalPoint, { x: 0.7, y: 0.6 });
      assert.deepEqual(result.settings.segments![0]!.focalPoint, { x: 0.7, y: 0.6 });
      assert.deepEqual(result.settings.segments![1], settings.segments[1]);
      assert.match(result.summary.join(" "), /70% across, 60% down/);
      reply = { patch: { captionStyle: { bottomPercent: 20 } } };
      const noCaptions = await propose({ ...settings, subtitleId: null }, "Set caption position to 20 percent");
      assert.match(noCaptions.summary.join(" "), /applies when captions are attached/);
      reply = { patch: { focalPoint: { x: 0.5, y: 0.5 } } };
      const centered = await propose({ ...settings, focalPoint: undefined }, "Center every source shot");
      assert.deepEqual(centered.settings.segments![0]!.focalPoint, { x: 0.5, y: 0.5 });
      assert.match(centered.summary.join(" "), /Focal point: 50% across, 50% down/);
    });

    await t.test("unknown controls, attachment IDs, unsafe values and nested keys cannot enter a proposal", async () => {
      const invalid = [
        { audioId: null }, { subtitleId: null }, { device: "Other camera" }, { stripMetadata: true }, { callouts: [] },
        { music: "https://example.com/audio.mp3" }, { filePath: "/private/path" }, { speed: 3 }, { volume: -1 },
        { temperature: 2 }, { gamma: 0 }, { noise: 2 }, { blend: 2 }, { frameBlend: 1 }, { timeShift: 6 },
        { resolution: "4k" }, { fps: "120" }, { hookDuration: 31 }, { hookText: "bad\u0000text" },
        { captionStyle: { fontSize: 50 } }, { captionStyle: { bottomPercent: 0 } }, { captionStyle: { color: "red" } },
        { focalPoint: { x: 2 } }, { focalPoint: { url: "private" } }, { segments: [] },
        { segments: [{ start: 10, end: 20, filePath: "/private/video" }] },
        { segments: [{ start: 10, end: 10.02 }] }, { segments: [{ start: -1, end: 1 }] },
      ];
      for (const patch of invalid) {
        reply = { patch: { brightness: 0.05, ...patch } };
        const settings = makeSettings(), before = structuredClone(settings);
        await assert.rejects(propose(settings), (error: unknown) => error instanceof PromptEditError && error.status === 502, JSON.stringify(patch));
        assert.deepEqual(settings, before);
      }
    });

    await t.test("source bounds and incompatible timeline operations reject the complete mixed edit", async () => {
      for (const patch of [
        { trimStart: 120 }, { trimEnd: 121 }, { trimStart: 30, trimEnd: 20 }, { trimStart: 20, trimEnd: 20.02 },
        { segments: [{ start: 110, end: 121 }] },
        { segments: [{ start: 10, end: 20 }], trimStart: 5 },
        { segments: [{ start: 10, end: 20 }], timeShift: 1 },
      ]) {
        reply = { patch: { brightness: 0.1, ...patch } };
        const settings = makeSettings(), before = structuredClone(settings);
        await assert.rejects(propose(settings), (error: unknown) => error instanceof PromptEditError && error.status === 422, JSON.stringify(patch));
        assert.deepEqual(settings, before);
      }
      reply = { patch: { timeShift: 1 } };
      await assert.rejects(propose({ ...makeSettings(), segments: [{ start: 10, end: 20 }] }), /Time shift applies to one continuous trim/);
      reply = { patch: { resolution: "1080" } };
      await assert.rejects(proposeManualPrompt({ settings: makeSettings(), source: { ...source, width: 100000, height: 100 }, prompt: "1080p", signal: new AbortController().signal }), /output size limit/);
    });

    await t.test("unsupported mixed requests and generated headings never partially apply filters", async () => {
      const settings = makeSettings();
      reply = { patch: { brightness: 0.1 }, clarification: "Voice generation is unavailable here. Do you want only the brighter picture?" };
      const unsupported = await propose(settings, "Brighten this and clone a voice");
      assert.deepEqual(unsupported.settings, settings);
      assert.deepEqual(unsupported.summary, []);
      assert.match(unsupported.clarification!, /Voice generation/);
      reply = { patch: { brightness: 0.1, hookText: "An invented video claim" } };
      const ungrounded = await propose(settings, "Brighten and rewrite the heading from the speech");
      assert.deepEqual(ungrounded.settings, settings);
      assert.deepEqual(ungrounded.summary, []);
      assert.match(ungrounded.clarification!, /exact heading/);
      reply = { patch: { hookText: "My exact title" } };
      assert.equal((await propose(settings, "Use the title My exact title")).settings.hookText, "My exact title");
      reply = { patch: { hookText: "" } };
      assert.equal((await propose(settings, "Remove the heading")).settings.hookText, "");
    });

    await t.test("empty and matching proposals return the unchanged settings with a clear explanation", async () => {
      const settings = makeSettings();
      for (const patch of [{}, { speed: 1, gamma: 1.1, normalizeAudio: false }, { focalPoint: { x: 0.5 }, captionStyle: { fontSize: 20 } }]) {
        reply = { patch };
        const result = await propose(settings, "Keep the same settings");
        assert.deepEqual(result.settings, settings);
        assert.deepEqual(result.summary, []);
        assert.match(result.clarification!, /already match/);
      }
    });

    await t.test("configuration and invalid input fail before any provider call", async () => {
      const before = requests;
      for (const prompt of ["", " ", "x".repeat(2001), "bad\u0000prompt"])
        await assert.rejects(propose(makeSettings(), prompt), /plain text/);
      await assert.rejects(propose({ ...makeSettings(), speed: 5 }), /current manual settings/);
      await assert.rejects(proposeManualPrompt({ settings: makeSettings(), source: { ...source, duration: 0 }, prompt: "Warm it", signal: new AbortController().signal }), /valid duration/);
      delete process.env.DEEPSEEK_API_KEY;
      await assert.rejects(propose(), (error: unknown) => error instanceof PromptEditError && error.status === 503);
      process.env.DEEPSEEK_API_KEY = "manual-prompt-private-test-key";
      process.env.DEEPSEEK_MODEL = "https://other-provider.test";
      await assert.rejects(propose(), /model is invalid/);
      delete process.env.DEEPSEEK_MODEL;
      assert.equal(requests, before);
    });

    await t.test("malformed responses expose no provider diagnostics and aborts stay cancellations", async () => {
      for (const response of [
        Response.json({ choices: [{ finish_reason: "stop", message: { content: "{broken" } }] }),
        Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }),
        new Response("secret diagnostics manual-prompt-private-test-key", { status: 403 }),
      ]) {
        fetchMock.mock.mockImplementationOnce(async () => response);
        await assert.rejects(propose(), (error: unknown) => error instanceof PromptEditError && error.status === 502 && !error.message.includes("private-test-key"));
      }
      reply = { patch: {}, summary: ["Video rendered"] };
      await assert.rejects(propose(), /unsupported or invalid setting/);
      const before = new AbortController(); before.abort();
      const requestsBefore = requests;
      await assert.rejects(proposeManualPrompt({ settings: makeSettings(), source, prompt: "Warm it", signal: before.signal }), { name: "AbortError" });
      assert.equal(requests, requestsBefore);
      const during = new AbortController();
      fetchMock.mock.mockImplementationOnce(async (_input, init) => { during.abort(); init?.signal?.throwIfAborted(); return complete({ patch: {} }); });
      await assert.rejects(proposeManualPrompt({ settings: makeSettings(), source, prompt: "Warm it", signal: during.signal }), { name: "AbortError" });
    });
  } finally {
    fetchMock.mock.restore();
    for (const [name, value] of Object.entries({ DEEPSEEK_API_KEY: original.key, DEEPSEEK_MODEL: original.model, DEEPSEEK_TEXT_MODEL: original.textModel }))
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
