import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { visualIdentity, similarPicture } from "../server/visual-identity.js";
import { footageContainment, footageOverlap } from "../server/diversity.js";
import { relatedHistory, previousEditorialPlans } from "../server/history.js";
import type { ExportHistoryEntry } from "../shared/types.js";

const exec = promisify(execFile);
test("picture history recognizes re-encodes and center portrait crops while rejecting unrelated or static footage", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-picture-test-"));
  const file = (name: string) => path.join(directory, `${name}.mp4`);
  const ffmpeg = (args: string[]) => exec("ffmpeg", ["-v", "error", "-y", ...args, "-threads", "1"]);
  try {
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "8", "-c:v", "libx264", file("original")]);
    await ffmpeg(["-i", file("original"), "-vf", "scale=426:240,eq=brightness=0.015", "-c:v", "libx264", "-crf", "30", file("reencoded")]);
    await ffmpeg(["-i", file("original"), "-vf", "crop=202:360,scale=270:480", "-c:v", "libx264", "-crf", "28", file("portrait")]);
    await ffmpeg(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=24", "-t", "8", "-pix_fmt", "yuv420p", "-c:v", "libx264", file("different")]);
    await ffmpeg(["-f", "lavfi", "-i", "color=black:size=320x180:rate=24", "-t", "8", "-c:v", "libx264", file("black")]);
    const [original, reencoded, portrait, different, black] = await Promise.all(["original", "reencoded", "portrait", "different", "black"].map(name => visualIdentity(file(name), 8)));
    assert.equal(original!.frames.length, 6);
    assert.ok(similarPicture(original, reencoded), "Resizing, brightness and compression preserve this picture identity");
    assert.ok(similarPicture(original, portrait), "A centered portrait crop can be recognized");
    assert.equal(similarPicture(original, different), undefined);
    assert.equal(similarPicture(black, black), undefined, "Generic flat frames provide no identity evidence");
    const still = { ...original!, frames: Array.from({ length: 6 }, () => original!.frames[0]!) };
    assert.equal(similarPicture(still, still), undefined, "Repeated static images provide insufficient temporal evidence");
    assert.equal(similarPicture(original, { ...original!, frames: original!.frames.slice(0, 4) }), undefined);
    assert.equal(similarPicture(original, { ...original!, duration: 15 }), undefined);
    assert.equal((await visualIdentity(file("missing"), 8)).frames.length, 0);
    const entry = { id: "prior", sourceFingerprint: "original-source-hash", sourcePicture: different, outputPicture: original, cuts: [{ start: 40, end: 48 }], sourceText: "Prior excerpt" } as ExportHistoryEntry;
    const related = relatedHistory([entry], { fingerprint: "new-encode-hash", picture: reencoded });
    assert.equal(related[0]?.match?.kind, "similar-export");
    assert.deepEqual(related[0]?.cuts, [{ start: 40, end: 48 }], "Do not invent a clock mapping for a probable re-export");
    assert.deepEqual(previousEditorialPlans(related, "new-encode-hash"), [], "Fuzzy matches must never reserve or exclude clips");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("history flags a shorter excerpt inside an earlier export without changing selection overlap", () => {
  const earlier = [{ start: 0, end: 30 }], shorter = [{ start: 10, end: 20 }];
  assert.equal(footageOverlap(earlier, shorter), 1 / 3);
  assert.equal(footageContainment(earlier, shorter), 1);
  assert.equal(footageContainment(shorter, earlier), 1);
  assert.equal(footageContainment(earlier, [{ start: 29, end: 39 }]), 0.1);
  assert.equal(footageContainment([], earlier), 0);
});
