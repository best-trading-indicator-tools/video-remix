import { groundGraphicScenes } from "../server/graphic-planner.js";
import { fixtureGraphics } from "./helpers/graphic-scenes.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planSupportingVisuals,
  prepareSupportingVisuals,
  removeGraphicCalloutOverlaps,
} from "../server/supporting-plan.js";
import {
  DEFAULT_SETTINGS,
  type BrollAsset,
  type RenderJob,
  type Transcript,
} from "../shared/types.js";
import type { StoredBroll, StoredJob, StoredSource } from "../server/store.js";

const asset = (id: string, name: string, tags: string[] = []): BrollAsset => ({
  id,
  name,
  tags,
  duration: 3,
  size: 100,
  width: 320,
  height: 180,
  fps: 30,
  hasAudio: true,
  createdAt: "",
  thumbnailUrl: "",
  url: "",
});
const transcript: Transcript = {
  language: "en",
  duration: 24,
  segments: [
    { start: 0.1, end: 2, text: "Start with the mountain view.", words: [] },
    {
      start: 4,
      end: 6.5,
      text: "Watch the sunset over the sea.",
      words: [
        { start: 4, end: 4.3, word: "Watch" },
        { start: 4.3, end: 4.5, word: "the" },
        { start: 4.5, end: 5, word: "sunset" },
        { start: 5, end: 5.3, word: "over" },
        { start: 5.3, end: 5.6, word: "the" },
        { start: 5.6, end: 6.5, word: "sea." },
      ],
    },
    { start: 13, end: 16, text: "Follow the mountain trail.", words: [] },
  ],
};

test("a requested B-roll count replaces duration caps and keeps trying later matching moments", () => {
  const spoken: Transcript = { language: "en", duration: 30, segments: Array.from({ length: 6 }, (_, index) => ({
    start: 4 + index * 4, end: 6 + index * 4, text: `topic${index} visible activity`, words: [],
  })) };
  const assets = spoken.segments.map((_, index) => asset(`clip-${index}`, `topic${index}.mp4`));
  for (const count of [1, 4, 6, 10]) {
    const result = planSupportingVisuals({ transcript: spoken, duration: 30, sourceName: "talk.mp4", assets, mode: "library", brollCount: count });
    assert.equal(result.length, Math.min(count, 6), `Try to fill ${count} distinct placements on the same 30-second edit`);
    assert.equal(new Set(result.map(shot => shot.assetId)).size, result.length);
    assert.ok(result.reduce((sum, shot) => sum + shot.end - shot.start, 0) <= 18 + 1e-8);
    assert.ok(result.every((shot, i) => shot.start >= 3.5 && shot.end <= 29.65 && (!i || shot.start >= result[i - 1]!.end + 0.6 - 1e-8)));
  }
  const later = planSupportingVisuals({ transcript: spoken, duration: 30, sourceName: "talk.mp4", assets: assets.slice(2), mode: "library", brollCount: 4 });
  assert.equal(later.length, 4, "Unmatched early speech cannot stop the search for later placements");
  assert.equal(later[0]!.start, 12);
});

test("AI backup matches fill later slots while collisions and irrelevant clips remain excluded", () => {
  const spoken: Transcript = { language: "en", duration: 30, segments: [4, 5, 10, 16, 22, 26].map((start, i) => ({ start, end: start + 2, text: `Idea ${i}`, words: [] })) };
  const assets = spoken.segments.map((_, i) => asset(`clip-${i}`, `unrelated-name-${i}.mp4`));
  const result = planSupportingVisuals({ transcript: spoken, duration: 30, sourceName: "talk.mp4", assets, mode: "library", brollCount: 4,
    aiMatches: assets.map((item, momentIndex) => ({ momentIndex, assetId: item.id, sourceStart: 0, reason: "Verified visual connection." })) });
  assert.deepEqual(result.map(shot => shot.start), [4, 10, 16, 22]);
  assert.deepEqual(planSupportingVisuals({ transcript: spoken, duration: 30, sourceName: "talk.mp4", assets, mode: "library", brollCount: 10, aiMatches: [] }), []);
});

test("a final motion rejection tries an alternative before reporting the achieved count", async () => {
  const assets: StoredBroll[] = ["a-still", "b-moving", "c-moving"].map(id => ({ ...asset(id, "sunset sea coast.mp4"),
    filePath: `/tmp/${id}.mp4`, thumbnailPath: "", stock: { providerId: `pixabay:${id}`, rendition: "https://cdn.pixabay.com/video/test.mp4", contentHash: id, retrievedAt: "", licenseUrl: "https://pixabay.com/service/license-summary/" } }));
  const source = { id: "source", name: "talk.mp4", width: 1280, height: 720, fps: 30, hasAudio: true, duration: 30 } as StoredSource;
  const job = { id: "test", auto: { aspect: "9:16", targetDuration: 30, narration: false, supportingVisuals: "library", brollCount: 2 }, settings: { ...DEFAULT_SETTINGS, aspect: "9:16" },
    summary: { title: "Talk", sourceDuration: 30, outputDuration: 30, changes: [], usedAI: false, narration: false, transcriptAvailable: true } } as StoredJob;
  const inspected: string[] = [];
  const result = await prepareSupportingVisuals({ source, job, assets, workDir: "/tmp", signal: new AbortController().signal, onPhase: () => {},
    transcript: { language: "en", duration: 30, segments: [4, 12, 20].map(start => ({ start, end: start + 2, text: "sunset sea coast", words: [] })) },
    inspect: async (clip) => { inspected.push(clip.filePath); return clip.filePath.includes("still") ? [] : [{ sourceStart: 0, duration: 3, motion: 1, cropRetention: 1 }]; } });
  assert.equal(result.length, 2);
  assert.deepEqual(job.supportingVisuals?.map(shot => shot.assetId), ["b-moving", "c-moving"]);
  assert.ok(inspected.some(file => file.includes("still")) && inspected.some(file => file.includes("c-moving")));
  assert.ok(job.notes?.some(note => note.includes("2 of 2 shots added")));
  assert.ok(!job.summary!.changes.some(change => change.includes("3 B-roll")));
});

test("supporting footage matches actual spoken moments using descriptive names or tags", () => {
  const result = planSupportingVisuals({
    transcript,
    duration: 24,
    sourceName: "travel.mp4",
    mode: "library",
    assets: [
      asset("unrelated", "cooking pasta.mp4"),
      asset("coast", "camera clip.mp4", ["sunset", "sea"]),
      asset("trail", "mountain trail.mp4"),
    ],
  });
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((item) => [item.assetId, item.start]),
    [
      ["coast", 4],
      ["trail", 13],
    ],
  );
  assert.ok(
    result.every((item) => item.end <= 24 && item.end - item.start <= 3),
  );
  assert.ok(!result.some((item) => item.assetId === "unrelated"));
});

test("supporting visuals stay optional and never invent speech for a silent clip", () => {
  const input = {
    sourceName: "sunset coast.mp4",
    duration: 15,
    assets: [asset("sea", "sunset.mp4")],
  };
  assert.deepEqual(planSupportingVisuals({ ...input, mode: "off" }), []);
  assert.deepEqual(planSupportingVisuals({ ...input, mode: "graphics" }), []);
  const matching = planSupportingVisuals({ ...input, mode: "library" });
  assert.equal(matching.length, 1);
  assert.equal(matching[0]?.assetId, "sea");
  assert.deepEqual(
    planSupportingVisuals({
      ...input,
      sourceName: "camera001.mp4",
      mode: "library",
    }),
    [],
  );
  assert.deepEqual(
    planSupportingVisuals({ ...input, duration: 3, mode: "library" }),
    [],
  );
});

test("graphic cards use existing spoken phrases and respect spacing and screen-time limits", () => {
  const result = planSupportingVisuals({
    transcript,
    duration: 24,
    sourceName: "travel.mp4",
    mode: "graphics",
    assets: [],
  });
  assert.equal(result.length, 2);
  assert.equal(result[0]?.text, "Watch the sunset over the sea.");
  assert.equal(result[1]?.text, "Follow the mountain trail.");
  assert.ok(
    result.every((item) => item.kind === "graphic" && item.start >= 3.5),
  );
  assert.ok(
    result.reduce((total, item) => total + item.end - item.start, 0) <=
      24 * 0.3,
  );
});

test("AI matches use the inspected source window without requiring filename keywords", () => {
  const result = planSupportingVisuals({
    transcript,
    duration: 24,
    sourceName: "travel.mp4",
    mode: "library",
    assets: [{ ...asset("coast", "IMG_4821.mp4"), duration: 30 }],
    aiMatches: [
      {
        momentIndex: 0,
        assetId: "coast",
        sourceStart: 13.2,
        reason:
          "The sampled frames show a coastline at dusk, illustrating the spoken sunset.",
      },
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.start, 4);
  assert.equal(result[0]!.sourceStart, 13.2);
  assert.equal(result[0]!.assetId, "coast");
  assert.match(result[0]!.reason!, /coastline/);
  assert.ok(result[0]!.end - result[0]!.start <= 3.6);
});

test("an AI rejection never falls back to keyword placement, and invalid references cannot create cutaways", () => {
  const input = {
    transcript,
    duration: 24,
    sourceName: "travel.mp4",
    mode: "library" as const,
    assets: [asset("coast", "sunset sea.mp4")],
  };
  assert.equal(planSupportingVisuals(input).length, 1);
  assert.deepEqual(planSupportingVisuals({ ...input, aiMatches: [] }), []);
  for (const match of [
    { momentIndex: 0, assetId: "not-selected", sourceStart: 0 },
    { momentIndex: 100, assetId: "coast", sourceStart: 0 },
    { momentIndex: 0, assetId: "coast", sourceStart: -1 },
    { momentIndex: 0, assetId: "coast", sourceStart: 2.9 },
    { momentIndex: 0, assetId: "coast", sourceStart: Number.NaN },
  ])
    assert.deepEqual(
      planSupportingVisuals({
        ...input,
        aiMatches: [{ ...match, reason: "Invalid suggestion" }],
      }),
      [],
    );
});

test("rendered cards suppress colliding callouts, preserve touching intervals and B-roll overlays, and update the edit summary", () => {
  const job: Pick<RenderJob, "settings" | "summary"> = {
    settings: {
      ...DEFAULT_SETTINGS,
      hookText: "Keep the opening hook",
      subtitleId: "captions-stay",
      callouts: [
        { text: "Ends at the card boundary", start: 2, end: 4 },
        { text: "Starts at the card boundary", start: 6, end: 8 },
        { text: "Overlaps the entrance", start: 3, end: 5 },
        { text: "Overlaps the exit", start: 5, end: 7 },
        { text: "Matches the card interval", start: 4, end: 6 },
        { text: "Useful over B-roll", start: 10, end: 12 },
      ],
    },
    summary: {
      title: "An edit",
      changes: ["Spoken hook", "Key-point overlays", "Speech captions"],
      sourceDuration: 24,
      outputDuration: 24,
      transcriptAvailable: true,
      usedAI: false,
      narration: false,
    },
  };
  removeGraphicCalloutOverlaps(job, [
    { kind: "graphic", start: 4, end: 6 },
    { kind: "broll", start: 10, end: 13 },
  ]);
  assert.deepEqual(
    job.settings.callouts?.map((callout) => callout.text),
    [
      "Ends at the card boundary",
      "Starts at the card boundary",
      "Useful over B-roll",
    ],
  );
  assert.ok(job.summary!.changes.includes("Key-point overlays"));
  assert.equal(job.settings.hookText, "Keep the opening hook");
  assert.equal(job.settings.subtitleId, "captions-stay");
  removeGraphicCalloutOverlaps(job, [{ kind: "graphic", start: 1, end: 14 }]);
  assert.deepEqual(job.settings.callouts, []);
  assert.deepEqual(job.summary!.changes, ["Spoken hook", "Speech captions"]);
});

const effortFixture = (visualSources: NonNullable<StoredJob["auto"]>["visualSources"], count = 4) => {
  const source = { id: "source", name: "camera advice.mp4", width: 1280, height: 720, fps: 24, hasAudio: true, duration: 10 } as StoredSource;
  const job = { id: "effort", auto: { aspect: "9:16", targetDuration: 10, narration: false, visualSources, brollCount: count }, settings: { ...DEFAULT_SETTINGS, aspect: "9:16" },
    summary: { title: "Camera advice", sourceDuration: 10, outputDuration: 10, changes: [], usedAI: false, narration: false, transcriptAvailable: true } } as StoredJob;
  const transcript: Transcript = { language: "en", duration: 10, segments: ["Use soft window light.", "Steady the camera tripod.", "Check your audio microphone.", "Frame the subject carefully."].map((text, i) => ({start:i*2.4,end:i*2.4+2.1,text,words:[]})) };
  return { planGraphics: fixtureGraphics, source, job, transcript, assets: [], workDir: "/tmp", signal: new AbortController().signal, onPhase: () => {} };
};

test("all best-effort passes obey the same coverage cap, counting retained shots", async () => {
  const input = effortFixture(["hyperframes", "remotion"], 10);
  input.job.auto!.brollMaxCoverage = 35;
  const occupied = [{ start: 0, end: 1.5 }];
  const result = await prepareSupportingVisuals({ ...input, occupied, available: async () => true, render: async () => {} });
  const covered = [...occupied, ...result].reduce((sum, shot) => sum + shot.end - shot.start, 0);
  assert.ok(result.length > 0, "Use remaining space rather than abandoning the search");
  assert.ok(covered <= 3.5 + 1e-9, `${covered}s exceeds the chosen 35% of 10 seconds`);
  assert.ok(input.job.visualFulfillment!.placed < 10);
  assert.match(input.job.notes!.join(" "), /coverage limit: 35%/);
  for (const effortRound of [0, 1, 2]) {
    const planned = planSupportingVisuals({ transcript: input.transcript, duration: 10, sourceName: "talk", assets: [], visualSources: ["remotion"], brollCount: 10, brollMaxCoverage: 20, effortRound, occupied });
    assert.ok([...occupied, ...planned].reduce((sum, shot) => sum + shot.end - shot.start, 0) <= 2 + 1e-9);
  }
});

test("zero coverage performs no cloud, matching or rendering work", async () => {
  const input = effortFixture(["pixabay", "hyperframes"]);
  input.job.auto!.brollMaxCoverage = 0;
  const unexpected = async () => { throw new Error("No work should be requested"); };
  const result = await prepareSupportingVisuals({ ...input, available: unexpected, findStock: unexpected, matchAI: unexpected, render: unexpected });
  assert.deepEqual(result, []);
  assert.equal(input.job.visualFulfillment!.attempts, 0);
  assert.match(input.job.visualFulfillment!.reason!, /coverage limit/);
});

test("four requested cards fill a ten-second short through tighter placements, without overwriting earlier files", async () => {
  const input = effortFixture(["hyperframes", "remotion"]);
  const outputs: string[] = [];
  const progress: NonNullable<StoredJob["visualSearch"]>[] = [];
  const result = await prepareSupportingVisuals({ ...input, available: async () => true,
    render: async (_engine, options) => { outputs.push(options.output); progress.push(structuredClone(input.job.visualSearch!)); } });
  assert.equal(result.length, 4);
  assert.ok(input.job.visualFulfillment!.attempts > 1);
  assert.equal(new Set(outputs).size, 4, "Separate passes must never overwrite a retained rendered card");
  assert.equal(input.job.supportingVisuals?.length, 4);
  assert.ok(result.every((shot,i) => shot.end <= 10 && (!i || shot.start >= result[i-1]!.end)));
  assert.ok(input.job.notes?.some(note => /4 of 4 shots added/.test(note)));
  assert.ok(progress.every(item => item.requested === 4 && item.budgetMs === 480_000 && item.maxPasses === 3));
  assert.equal(new Set(progress.map(item => item.startedAt)).size, 1, "Elapsed time is measured across passes");
  assert.ok(progress.some(item => item.pass === 2 && item.placed > 0), "Later passes report retained shots");
  assert.equal(input.job.visualSearch, undefined, "Live search status must clear before rendering");
});

test("failed and cancelled visual searches clear their live counters", async () => {
  const input = effortFixture(["pexels"]);
  await assert.rejects(prepareSupportingVisuals({ ...input, findStock: async () => { throw new Error("test failure"); } }), /test failure/);
  assert.equal(input.job.visualSearch, undefined);
  const controller = new AbortController();
  await assert.rejects(prepareSupportingVisuals({ ...input, signal: controller.signal,
    findStock: async () => { controller.abort(); controller.signal.throwIfAborted(); throw new Error("unreachable"); } }), { name: "AbortError" });
  assert.equal(input.job.visualSearch, undefined);
});

test("failed cards try another selected renderer and unavailable targets report a bounded shortage", async () => {
  const input = effortFixture(["hyperframes", "remotion"], 1);
  const engines: string[] = [];
  const result = await prepareSupportingVisuals({ ...input, available: async () => true,
    render: async engine => { engines.push(engine); if (engine === "hyperframes") throw new Error("renderer failure"); } });
  assert.equal(result.length, 1); assert.equal(result[0]?.visualSource, "remotion");
  assert.deepEqual(engines, ["hyperframes", "remotion"]);
  const impossible = effortFixture(["hyperframes"], 10);
  const empty = await prepareSupportingVisuals({ ...impossible, available: async () => false });
  assert.equal(empty.length, 0); assert.equal(impossible.job.visualFulfillment!.attempts, 3);
  assert.equal(impossible.job.visualFulfillment!.requested, 10);
  assert.ok(impossible.job.visualFulfillment!.reason);
});

test("stock shortfalls trigger more searches and keep matched shots while rejecting already-used stock", async () => {
  const input = effortFixture(["pexels"]);
  const rounds: number[] = [];
  const created: StoredBroll[] = input.transcript.segments.map((segment,i) => ({ ...asset(`asset-${i}`, segment.text),
    filePath:`/tmp/shot-${i}.mp4`, thumbnailPath:"", stock:{providerId:`pexels:${i}`,rendition:"https://videos.pexels.com/video-files/test.mp4",contentHash:String(i),retrievedAt:"",licenseUrl:"https://www.pexels.com/license/"} }));
  const result = await prepareSupportingVisuals({ ...input,
    matchAI: async ({ assets, moments }) => ({ matches: moments.flatMap((moment, momentIndex) =>
      assets.filter(asset => asset.name === moment.text).map(asset => ({ momentIndex, assetId: asset.id, sourceStart: 0, reason: "Visible matched scene" }))), notes: [] }),
    findStock: async options => {
      rounds.push(options.searchRound!);
      const clips = options.searchRound === 0 ? [created[2]!] : created.filter(asset => !options.excludedStockIds?.includes(asset.stock!.providerId));
      return { assets: clips, notes: [] };
    },
    inspect: async () => [{sourceStart:0,duration:3,motion:1,cropRetention:1}],
  });
  assert.equal(result.length, 4);
  assert.deepEqual(rounds, [0,1]);
  assert.equal(new Set(input.job.supportingVisuals!.map(shot=>shot.stock!.providerId)).size, 4);
  assert.equal(input.job.brollCandidates?.length, 4);
});


test("no verified scene never falls back to rendering generic text cards", async () => {
  const input = effortFixture(["hyperframes", "remotion"]);
  let attempts = 0;
  const result = await prepareSupportingVisuals({ ...input, available: async () => true,
    planGraphics: async () => { attempts++; return { scenes: new Map(), notes: [] }; },
    render: async () => { assert.fail("A spoken phrase without a useful scene must not render"); } });
  assert.deepEqual(result, []);
  assert.equal(attempts, 3, "Best effort remains bounded");
  assert.ok(input.job.notes?.some(note => /No useful illustration/u.test(note)));
});


test("word-timed diagrams can explain a complete relationship within coverage and reserved-shot limits", async () => {
 const input=effortFixture(["remotion"],1);
 input.source.duration=20; input.job.summary!.outputDuration=20;
 const text="A morning message lets another person know you care and helps them feel connected.";
 const words=text.split(" ").map((word,index)=>({word,start:4+index*.3,end:4+index*.3+.24}));
 input.transcript={language:"en",duration:20,segments:[{start:4,end:8.5,text,words}]};
 let designed=false;
 const result=await prepareSupportingVisuals({...input,occupied:[{start:10,end:12}],available:async()=>true,
  planGraphics:async({moments})=>{
   const moment=moments[0]!; assert.match(moment.text,/feel connected/); assert.ok(moment.end-moment.start>3.6);
   designed=true;
   const scenes=groundGraphicScenes({scenes:[{momentIndex:0,scene:{kind:"process",title:"A small check-in",reason:"Shows the stated connection between a message and feeling connected.",unit:"",nodes:[
    {label:"Morning message",icon:"phone",quote:"morning message",value:null,at:0},
    {label:"Connection",icon:"people",quote:"helps them feel connected",value:null,at:0}]} }]},moments);
   return {scenes,notes:[]};
  },render:async(_engine,options)=>{assert.equal(options.scene?.kind,"process");}});
 assert.equal(designed,true);assert.equal(result.length,1);assert.ok(result[0]!.end<=8.8);
 assert.ok(result[0]!.end-result[0]!.start+2<=12);
 assert.equal(input.job.supportingVisuals?.[0]?.graphicScene?.kind,"process");
});
