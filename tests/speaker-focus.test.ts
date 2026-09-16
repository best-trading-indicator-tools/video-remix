import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  analyzeSpeakerFocus,
  speakerFocusAvailable,
} from "../server/speaker-focus.js";
import { runLocal } from "../server/auto-process.js";

test("face framing validates bounded selections and cancellation before inspecting media", async () => {
  const base = {
    source: {
      filePath: "/missing/private/video.mp4",
      duration: 400,
      width: 640,
      height: 360,
    },
    cuts: [{ start: 0, end: 4 }],
    signal: new AbortController().signal,
  };
  for (const cuts of [
    [],
    [{ start: -1, end: 3 }],
    [{ start: 3, end: 2 }],
    [{ start: 0, end: NaN }],
    [{ start: 399, end: 401 }],
    Array.from({ length: 61 }, () => ({ start: 0, end: 1 })),
  ]) {
    await assert.rejects(
      analyzeSpeakerFocus({ ...base, cuts }),
      /valid source intervals/,
    );
  }
  await assert.rejects(
    analyzeSpeakerFocus({ ...base, seed: { x: 1.1, y: 0.5 } }),
    /valid source intervals/,
  );
  await assert.rejects(
    analyzeSpeakerFocus({ ...base, signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );
  const missing = await analyzeSpeakerFocus(base);
  assert.equal(missing.status, "unavailable");
  assert.deepEqual(missing.tracks, []);
  assert.ok(!missing.reason?.includes("/missing/private"));
  assert.equal(
    (await analyzeSpeakerFocus({ ...base, cuts: [{ start: 0, end: 399 }] }))
      .status,
    "unavailable",
    "Long selections reach media validation instead of an arbitrary duration limit",
  );
});

test(
  "local YuNet follows a moving face, respects selected timestamps, preserves no-face fallback and chooses the seeded person",
  { timeout: 100_000 },
  async (t) => {
    if (!(await speakerFocusAvailable())) {
      if (process.env.REQUIRE_FOCUS_TESTS === "true")
        assert.fail("Run npm run setup:focus before these tests");
      t.skip(
        "Install the local face-framing dependency with npm run setup:focus",
      );
      return;
    }
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "video-remix-focus-test-"),
    );
    const cacheDir = path.join(directory, "cache");
    const fixture = path.resolve("tests/fixtures/astronaut.jpg");
    const moving = path.join(directory, "moving.mp4");
    const blank = path.join(directory, "blank.mp4");
    const sequence = path.join(directory, "sequence.mp4");
    const people = path.join(directory, "people.mp4");
    const anamorphic = path.join(directory, "anamorphic.mp4");
    const source = {
      filePath: moving,
      width: 640,
      height: 360,
      duration: 4,
      fingerprint: "fixture-content-identity",
    };
    const options = {
      source,
      cuts: [{ start: 0, end: 4 }],
      signal: new AbortController().signal,
      cacheDir,
    };
    const ffmpeg = (args: string[]) =>
      runLocal(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args],
        { timeout: 20_000 },
      );
    try {
      await ffmpeg([
        "-loop",
        "1",
        "-i",
        fixture,
        "-f",
        "lavfi",
        "-i",
        "color=c=0x1a2436:s=640x360:r=12:d=4",
        "-filter_complex",
        "[0:v]crop=256:256:120:20,scale=180:180[face];[1:v][face]overlay=x=40+70*t:y=55:shortest=1",
        "-t",
        "4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        moving,
      ]);
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=640x360:r=12:d=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        blank,
      ]);
      const result = await analyzeSpeakerFocus(options);
      assert.equal(result.status, "tracked");
      assert.equal(result.multipleFaces, false);
      assert.equal(result.sampledFrames, 8);
      assert.equal(result.detectedFrames, 8);
      const track = result.tracks[0]!;
      assert.deepEqual(
        [
          track.start,
          track.end,
          track.keyframes[0]!.time,
          track.keyframes.at(-1)!.time,
        ],
        [0, 4, 0, 4],
      );
      assert.ok(
        track.keyframes[0]!.x < 0.3 && track.keyframes.at(-1)!.x > 0.54,
        "Crop follows the real face across the image",
      );
      assert.ok(
        track.keyframes.every((point) => point.y > 0.28 && point.y < 0.4),
      );
      assert.ok(
        track.keyframes.every(
          (point, index) =>
            index === 0 || point.x >= track.keyframes[index - 1]!.x - 0.015,
        ),
        "Detector jitter does not reverse a steady pan",
      );
      assert.ok(
        track.keyframes.every(
          (point, index) =>
            index === 0 ||
            Math.abs(point.y - track.keyframes[index - 1]!.y) < 0.03,
        ),
      );
      const cacheFiles = await readdir(cacheDir);
      assert.equal(cacheFiles.length, 1);
      const cacheText = await readFile(
        path.join(cacheDir, cacheFiles[0]!),
        "utf8",
      );
      assert.ok(
        !cacheText.includes(directory),
        "Cache stores positions, not private media or temporary frame paths",
      );
      assert.deepEqual(
        await analyzeSpeakerFocus(options),
        result,
        "An unchanged selection reuses its cached result",
      );

      await ffmpeg([
        "-i",
        moving,
        "-vf",
        "scale=320:360,setsar=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        anamorphic,
      ]);
      const displayTrack = await analyzeSpeakerFocus({
        ...options,
        source: { ...source, filePath: anamorphic, width: 320 },
      });
      assert.equal(displayTrack.status, "tracked");
      assert.ok(
        Math.abs(
          displayTrack.tracks[0]!.keyframes[0]!.x - track.keyframes[0]!.x,
        ) < 0.03,
        "Anamorphic source pixels are detected at display proportions",
      );
      assert.ok(
        Math.abs(
          displayTrack.tracks[0]!.keyframes.at(-1)!.x -
            track.keyframes.at(-1)!.x,
        ) < 0.03,
      );

      await ffmpeg([
        "-i",
        blank,
        "-i",
        moving,
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[out]",
        "-map",
        "[out]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        sequence,
      ]);
      const selected = await analyzeSpeakerFocus({
        ...options,
        source: { ...source, filePath: sequence, duration: 8 },
        cuts: [
          { start: 4, end: 8 },
          { start: 0, end: 3 },
        ],
      });
      assert.equal(selected.status, "partial");
      assert.equal(selected.tracks.length, 1);
      assert.equal(selected.tracks[0]!.cutIndex, 0);
      assert.equal(selected.tracks[0]!.start, 4);
      assert.ok(
        selected.tracks[0]!.keyframes.every(
          (point) => point.time >= 4 && point.time <= 8,
        ),
        "Tracks use absolute source seconds, including reordered cuts",
      );

      await ffmpeg([
        "-loop",
        "1",
        "-i",
        fixture,
        "-f",
        "lavfi",
        "-i",
        "color=c=0x1a2436:s=640x360:r=12:d=2",
        "-filter_complex",
        "[0:v]crop=256:256:120:20,scale=180:180,split=2[left][right];[1:v][left]overlay=x=30:y=55:shortest=1[first];[first][right]overlay=x=390:y=55:shortest=1",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        people,
      ]);
      for (const x of [0.2, 0.8]) {
        const person = await analyzeSpeakerFocus({
          ...options,
          source: { ...source, filePath: people, duration: 2 },
          cuts: [{ start: 0, end: 2 }],
          seed: { x, y: 0.35 },
        });
        assert.equal(person.status, "tracked");
        assert.equal(person.multipleFaces, true);
        assert.ok(
          person.reason?.includes("does not identify the active voice"),
        );
        assert.ok(
          person.tracks[0]!.keyframes.every(
            (point) => Math.abs(point.x - x) < 0.13,
          ),
          "The manual seed selects the intended visible person",
        );
      }
      const perCut = await analyzeSpeakerFocus({
        ...options,
        source: { ...source, filePath: people, duration: 2 },
        seed: { x: 0.2, y: 0.35 },
        cuts: [
          { start: 0, end: 2, focalPoint: { x: 0.2, y: 0.35 } },
          { start: 0, end: 2, focalPoint: { x: 0.8, y: 0.35 } },
        ],
      });
      assert.equal(perCut.tracks.length, 2);
      assert.ok(perCut.tracks[0]!.keyframes.every((point) => point.x < 0.3));
      assert.ok(
        perCut.tracks[1]!.keyframes.every((point) => point.x > 0.7),
        "Each repeated cut honors its own manual seed over the global seed",
      );

      await copyFile(blank, moving);
      const replaced = await analyzeSpeakerFocus(options);
      assert.equal(
        replaced.status,
        "no-face",
        "A replaced source invalidates cached tracking, even with an unchanged supplied fingerprint",
      );
      assert.deepEqual(replaced.tracks, []);
      assert.equal(replaced.detectedFrames, 0);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 100);
      try {
        await assert.rejects(
          analyzeSpeakerFocus({
            ...options,
            cuts: [{ start: 0.1, end: 3.9 }],
            signal: controller.signal,
          }),
          { name: "AbortError" },
        );
      } finally {
        clearTimeout(timeout);
      }
      assert.ok(
        (await readdir(cacheDir)).every((name) => name.endsWith(".json")),
        "Success and cancellation remove extracted frames and partial cache files",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "tracking keeps brief misses stable, falls back for long gaps, and bounds the crop expression",
  { timeout: 15_000 },
  async (t) => {
    const python = path.resolve(
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    try {
      await runLocal(python, ["--version"], { timeout: 3000 });
    } catch {
      t.skip(
        "A local Python interpreter is needed for the tracking unit checks",
      );
      return;
    }
    const script = `
import importlib.util,json
spec=importlib.util.spec_from_file_location("speaker_focus","scripts/speaker_focus.py")
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
def face(x): return {"x":x,"y":0.35,"area":0.035,"confidence":0.95}
samples=[{"cutIndex":0,"time":i*.5+.25,"faces":[face(.7)] if i<5 or i>11 else []} for i in range(16)]
gap=module.track_samples(samples,[{"start":0,"end":8}],{"x":.3,"y":.5})
cuts=[{"start":i*2,"end":i*2+2} for i in range(60)]
many=[{"cutIndex":i,"time":i*2+(j+.5)*2/3,"faces":[face(.2+j*.1)]} for i in range(60) for j in range(3)]
bounded=module.track_samples(many,cuts)
single=module.track_samples([{"cutIndex":0,"time":i*.5+.25,"faces":[face(.5+(.05 if i%2 else -.05))]} for i in range(180)],[{"start":0,"end":90}])
stationary=module.track_samples([{"cutIndex":0,"time":i*.5+.25,"faces":[face(.3 if i<5 else .3+(i-4)*.05)]} for i in range(8)],[{"start":0,"end":4}])
held=module.track_samples([{"cutIndex":0,"time":i*.5+.25,"faces":[face(.2 if i<10 else .45)]} for i in range(16)],[{"start":0,"end":8}],{"x":.2,"y":.35})
print(json.dumps({"gap":gap,"bounded":bounded,"single":single,"stationary":stationary,"held":held}))
`;
    const output = JSON.parse(
      (await runLocal(python, ["-c", script], { timeout: 10_000 })).stdout,
    );
    assert.equal(output.gap.status, "partial");
    const stationary = output.stationary.tracks[0].keyframes as Array<{
      time: number;
      x: number;
    }>;
    const before = stationary.filter((point) => point.time <= 2).at(-1)!;
    const after = stationary.find((point) => point.time > 2)!;
    const atTwoSeconds =
      before.x +
      ((after.x - before.x) * (2 - before.time)) / (after.time - before.time);
    assert.ok(
      Math.abs(atTwoSeconds - 0.3) < 0.002,
      "Linear interpolation holds still until the subject starts moving, even after simplification",
    );
    assert.ok(
      stationary.at(-1)!.x > 0.42,
      "The pan still follows subsequent real movement",
    );
    const held = output.held.tracks[0].keyframes as Array<{ time: number; x: number }>;
    for (const time of [3, 4.5, 4.75]) {
      const before = held.filter(point => point.time <= time).at(-1)!;
      const after = held.find(point => point.time > time)!;
      const interpolated = before.x + (after.x - before.x) * (time - before.time) / (after.time - before.time);
      assert.ok(Math.abs(interpolated - 0.2) < 0.002, "A held frame stays stationary before an abrupt subject movement");
    }
    assert.ok(held.at(-1)!.x > 0.44);
    const points = output.gap.tracks[0].keyframes as Array<{
      time: number;
      x: number;
    }>;
    assert.ok(
      points.find(
        (point) => point.time >= 4 && point.time <= 5 && point.x < 0.4,
      ),
      "A long occlusion returns to the user's manual seed",
    );
    assert.ok(
      points
        .filter((point) => point.time < 3)
        .every((point) => Math.abs(point.x - 0.7) < 0.02),
      "Brief misses hold the subject instead of jumping to another person",
    );
    assert.ok(
      output.bounded.tracks.reduce(
        (sum: number, track: { keyframes: unknown[] }) =>
          sum + track.keyframes.length,
        0,
      ) <= 240,
    );
    assert.ok(
      output.bounded.tracks.every(
        (track: {
          start: number;
          end: number;
          keyframes: Array<{ time: number }>;
        }) =>
          track.keyframes[0]!.time === track.start &&
          track.keyframes.at(-1)!.time === track.end,
      ),
    );
    assert.ok(output.single.tracks[0].keyframes.length <= 120);
  },
);
