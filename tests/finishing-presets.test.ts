import assert from "node:assert/strict";
import { test } from "node:test";
import { captureFinishingPreset, migrateManualPresets, restoreFinishingPresets } from "../shared/finishing-presets.js";
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS } from "../shared/types.js";
import { createShortDraft, validateShortDraft } from "../shared/shorts.js";
import { autoOptionsSchema, settingsSchema } from "../server/schema.js";

test("manual finishing presets retain appearance while excluding every source-specific edit and private field", () => {
  const original = { ...DEFAULT_SETTINGS, segments: [{ start: 10, end: 20 }], trimStart: 3, trimEnd: 22, speed: 1.2, timeShift: 2,
    hookText: "Specific quote", callouts: [{start:0,end:2,text:"Specific point"}], audioId: "source-audio", subtitleId: "source-caption",
    focalPoint: {x:0.2,y:0.3}, secondaryFocalPoint: {x:0.8,y:0.4}, brightness: 0.1, normalizeAudio: true,
    captionStyle: {fontSize:24,bottomPercent:15}, apiKey: "should never be saved" };
  const preset = captureFinishingPreset("manual", "Podcast", original, "one");
  assert.equal(preset.mode, "manual");
  for (const key of ["segments","trimStart","trimEnd","speed","timeShift","hookText","callouts","audioId","subtitleId","focalPoint","secondaryFocalPoint","apiKey"])
    assert.equal(key in preset.settings, false, key);
  const applied = { ...original, ...preset.settings };
  assert.deepEqual(applied.segments, original.segments); assert.equal(applied.subtitleId, original.subtitleId); assert.equal(applied.speed, original.speed);
  assert.equal(applied.brightness, 0.1); assert.deepEqual(applied.captionStyle, {fontSize:24,bottomPercent:15});
  assert.equal(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...preset.settings }).success, true);
  assert.deepEqual(restoreFinishingPresets(JSON.parse(JSON.stringify({version:1,presets:[preset]}))), [preset]);
});

test("Auto finishing saves caption and stock choices but keeps duration, narration, versions and attachments with the video", () => {
  const preset = captureFinishingPreset("auto", "Stock podcast", { ...DEFAULT_AUTO_OPTIONS, captions: "keep", visualSources: ["pexels", "remotion"], brollCount: 6, targetDuration: 90, narration: true, brollIds: ["private-clip"], variants: 4 }, "auto");
  assert.equal(preset.mode, "auto"); if (preset.mode !== "auto") return;
  assert.deepEqual(preset.settings.visualSources, ["pexels", "remotion"]); assert.equal(preset.settings.brollCount, 6); assert.equal(preset.settings.captions, "keep");
  for (const key of ["targetDuration", "narration", "variants", "brollIds"]) assert.equal(key in preset.settings, false);
  const applied = { ...DEFAULT_AUTO_OPTIONS, targetDuration: 35, ...preset.settings };
  assert.equal(autoOptionsSchema.parse(applied).targetDuration, 35);
});

test("Short finishing presets preserve target sequences and subject coordinates, including batch application", () => {
  const source = {id:"s",name:"source",duration:90,width:1920,height:1080} as Parameters<typeof createShortDraft>[0];
  const first = { ...createShortDraft(source,"one","c1",0), layout: "split" as const, normalizeAudio: true };
  const second = { ...createShortDraft(source,"two","c2",40), focalPoint:{x:0.8,y:0.4} };
  const preset = captureFinishingPreset("shorts","Stacked",first,"short");
  assert.equal(preset.mode,"shorts"); if (preset.mode !== "shorts") return;
  const applied = {...second,...preset.settings};
  assert.deepEqual(applied.cuts,second.cuts); assert.deepEqual(applied.focalPoint,second.focalPoint); assert.equal(applied.layout,"split");
  assert.equal(validateShortDraft(applied,source).errors.length,0);
});

test("preset restoration validates data, bounds collection size and safely migrates old manual presets", () => {
  const preset = captureFinishingPreset("manual","Existing",DEFAULT_SETTINGS,"existing");
  assert.equal(restoreFinishingPresets({version:1,presets:[preset,preset,{...preset,id:"bad",settings:{brightness:999}}]}).length,1);
  assert.equal(restoreFinishingPresets({version:2,presets:[preset]}).length,0);
  assert.equal(restoreFinishingPresets({version:1,presets:Array.from({length:100},(_,i)=>({...preset,id:String(i)}))}).length,60);
  const migrated = migrateManualPresets([{id:"legacy",name:"Legacy finish",settings:{...DEFAULT_SETTINGS,segments:[{start:400,end:420}],hookText:"Old"}},null]);
  assert.equal(migrated.length,1); assert.equal("segments" in migrated[0].settings,false); assert.equal("hookText" in migrated[0].settings,false);
  assert.throws(() => captureFinishingPreset("shorts","",DEFAULT_SETTINGS,"invalid"));
});
