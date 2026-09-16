import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runLocal } from "../server/auto-process.js";
import { renderVideo, probeMedia } from "../server/engine.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { createShortDraft, restoreShortDrafts, shortFocusSignature, validateShortDraft } from "../shared/shorts.js";
import { settingsSchema } from "../server/schema.js";
import { analyzeActiveSpeaker } from "../server/active-speaker.js";

test("speaker tracking policy holds on silence and ambiguous overlap, confirms changes, and permits a disappeared speaker to be replaced", async () => {
  const script = `import sys\nsys.path.insert(0, 'scripts')\nfrom active_speaker import select_speaker\na={'id':1,'score':2}\nb={'id':2,'score':-1}\nassert select_speaker([a,b],None,None,0,-99,0)[0]['id']==1\na['score']=-1; b['score']=2\nr=select_speaker([a,b],1,None,0,0,2)\nassert r[0]['id']==1 and r[1]==2\nr=select_speaker([a,b],1,r[1],r[2],r[3],2.6)\nassert r[0]['id']==2\na['score']=2; b['score']=1.9\nassert select_speaker([a,b],2,None,0,0,4)[0]['id']==2\na['score']=-2; b['score']=-2\nassert select_speaker([a,b],2,None,0,0,5)[0]['id']==2\na['score']=2\nassert select_speaker([a],2,None,0,0,6)[0]['id']==1\nprint('ok')`;
  assert.equal((await runLocal("python3", ["-c", script], { timeout: 10000 })).stdout.trim(), "ok");
});

test("speaker modes invalidate cached tracks and layouts survive draft restore and API validation", () => {
  const source = { id: "s", name: "source", duration: 20, width: 1920, height: 1080 } as Parameters<typeof createShortDraft>[0];
  const draft = { ...createShortDraft(source, "draft", "cut"), layout: "split" as const, secondaryFocalPoint: { x: 0.8, y: 0.4 } };
  const restored = restoreShortDrafts({ version: 1, drafts: [draft] })[0];
  assert.equal(restored.layout, "split"); assert.deepEqual(restored.secondaryFocalPoint, draft.secondaryFocalPoint);
  assert.notEqual(shortFocusSignature(draft), shortFocusSignature({ ...draft, focusMode: "speaker" }));
  const settings = validateShortDraft(restored, source).settings!;
  assert.equal(settingsSchema.parse(settings).layout, "split");
  assert.equal(settingsSchema.safeParse({ ...settings, secondaryFocalPoint: { x: 2, y: 0.4 } }).success, false);
});

test("active speaker rejects invalid cuts, has a bounded local workload, and honors cancellation", async () => {
  const options = { source: { filePath: "/missing", duration: 1000, width: 640, height: 360 }, cuts: [{ start: 0, end: 3 }], signal: new AbortController().signal };
  await assert.rejects(analyzeActiveSpeaker({ ...options, cuts: [{ start: -1, end: 4 }] }));
  assert.equal((await analyzeActiveSpeaker({ ...options, cuts: [{ start: 0, end: 601 }] })).status, "unavailable");
  await assert.rejects(analyzeActiveSpeaker({ ...options, signal: AbortSignal.abort() }));
});

test("stacked speaker and presentation layouts render different source regions with original audio", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-layout-"));
  try {
    const sourceFile = path.join(directory, "source.mp4");
    await runLocal("ffmpeg", ["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=red:s=640x360:r=12:d=1,drawbox=x=320:y=0:w=320:h=360:c=blue:t=fill","-f","lavfi","-i","sine=frequency=400:duration=1","-c:v","libx264","-preset","ultrafast","-threads","1","-c:a","aac","-shortest",sourceFile], { timeout: 10000 });
    const source = await probeMedia(sourceFile);
    for (const layout of ["split", "presentation"] as const) {
      const output = path.join(directory, `${layout}.mp4`);
      await renderVideo({ input: sourceFile, output, workDir: directory, source,
        settings: { ...DEFAULT_SETTINGS, aspect: "9:16", resolution: "source", layout, focalPoint: { x: 0, y: 0.5 }, secondaryFocalPoint: { x: 1, y: 0.5 } },
        signal: new AbortController().signal, onProgress: () => {} });
      const metadata = await probeMedia(output);
      assert.equal(metadata.hasAudio, true); assert.ok(Math.abs(metadata.duration - 1) < 0.15);
      const pixel = async (x: number, y: number) => {
        const { stdout } = await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", output, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},scale=1:1`, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
        return [...stdout];
      };
      const top = await pixel(Math.floor(metadata.width * 0.25), Math.floor(metadata.height * 0.3));
      assert.ok(top[0] > 200 && top[2] < 40, `Upper panel should retain the red left subject: ${top}`);
      const bottom = await pixel(Math.floor(metadata.width / 2), Math.floor(metadata.height * 0.8));
      if (layout === "split") assert.ok(bottom[2] > 200 && bottom[0] < 40, `Lower panel should show blue right subject: ${bottom}`);
      else {
        assert.ok(bottom[0] > 200 && bottom[2] < 40, `Presentation close-up should follow red subject: ${bottom}`);
        const topRight = await pixel(Math.floor(metadata.width * 0.75), Math.floor(metadata.height * 0.3));
        assert.ok(topRight[2] > 200, "Presentation overview must retain the other side of the source");
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
