import assert from "node:assert/strict";
import { test } from "node:test";
import { captionDisplayText } from "../shared/caption-text.js";
import { DEFAULT_CAPTION_STYLE } from "../shared/caption-style.js";
import { captionsAss } from "../server/caption-ass.js";

const style = { ...DEFAULT_CAPTION_STYLE, cyrillicMode: "words" as const, cyrillicWords: ["Sample-12", "Example phrase"] };

test("Cyrillic lookalikes are opt-in, literal and limited to whole words or phrases", () => {
  const text = "Sample-12, sample-12! Example\nphrase. Samples Sample-123 preSample-12 Sample-12β Sample-12\u0301";
  assert.equal(captionDisplayText(text), text);
  assert.equal(captionDisplayText(text, { ...style, cyrillicMode: "off" }), text);
  assert.equal(captionDisplayText(text, { ...style, cyrillicWords: [] }), text);
  const shown = captionDisplayText(text, style);
  assert.equal(shown, "Ѕаmрlе-12, ѕаmрlе-12! Ехаmрlе\nрhrаѕе. Samples Sample-123 preSample-12 Sample-12β Sample-12\u0301");
  assert.equal(captionDisplayText(shown, style), shown);
  assert.equal(captionDisplayText("a.b a+b a?b axb", { ...style, cyrillicWords: ["a.b", "a+b", "a?b"] }), "а.b а+b а?b axb");
});

test("all-text and uppercase preserve spacing, punctuation, numbers and existing Cyrillic", () => {
  assert.equal(captionDisplayText("Case 123!\nПривет 😀", { ...style, cyrillicMode: "all" }), "Саѕе 123!\nПривет 😀");
  assert.equal(captionDisplayText("Sample-12 outside", { ...style, uppercase: true }), "ЅАМРLЕ-12 OUTSIDE");
  assert.equal(captionDisplayText("Sample-12 outside", { ...style, uppercase: true, cyrillicMode: "off" }), "SAMPLE-12 OUTSIDE");
  assert.equal(captionDisplayText("not replaced", { ...style, cyrillicWords: [" "] }), "not replaced");
});

test("highlighted ASS draws converted text but keeps recognized timings against original words", () => {
  const cues = [{ start: 0, end: 3, text: "Sample-12 comes next" }];
  const before = structuredClone(cues);
  const words = [
    { word: "Sample-12", start: 0, end: 0.3, probability: 1 },
    { word: "comes", start: 0.4, end: 0.7, probability: 1 },
    { word: "next", start: 2.1, end: 2.8, probability: 1 },
  ];
  const ass = captionsAss(cues, { ...style, uppercase: true, wordHighlight: true }, words);
  const lines = ass.split("\n").filter(line => line.startsWith("Dialogue:"));
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^Dialogue: 0,0:00:00\.00,0:00:00\.40,/u);
  assert.match(lines[1]!, /^Dialogue: 0,0:00:00\.40,0:00:02\.10,/u);
  assert.match(lines[2]!, /^Dialogue: 0,0:00:02\.10,0:00:03\.00,/u);
  assert.ok(lines.every(line => line.includes("ЅАМРLЕ-12")));
  assert.deepEqual(cues, before);
  assert.match(captionsAss(cues, style), /Ѕаmрlе-12 comes next/u);
});
