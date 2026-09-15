import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  checkBinaries,
  createThumbnail,
  probeAudio,
  probeMedia,
  renderVideo,
} from "../server/engine.js";
import { DEFAULT_SETTINGS, type RemixSettings } from "../shared/types.js";
import type { SupportingVisual } from "../server/visuals.js";

let directory: string;
let landscape: string;
let portrait: string;
let audio: string;
let scenes: string;

function ffmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "2",
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr)),
    );
  });
}

before(async () => {
  assert.deepEqual(
    await checkBinaries(),
    { ffmpeg: true, ffprobe: true },
    "FFmpeg and ffprobe are required for the integration suite",
  );
  directory = await mkdtemp(path.join(os.tmpdir(), "video-remix-engine-"));
  landscape = path.join(directory, "source ' with spaces.mp4");
  portrait = path.join(directory, "portrait.mp4");
  audio = path.join(directory, "voice.wav");
  scenes = path.join(directory, "three-scenes.mp4");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-metadata",
    "title=private source title",
    "-shortest",
    landscape,
  ]);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=180x320:rate=24:duration=2",
    "-an",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    portrait,
  ]);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=0.3",
    audio,
  ]);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x180:r=30:d=1[r];color=lime:s=320x180:r=30:d=1[g];color=blue:s=320x180:r=30:d=1[b];[r][g][b]concat=n=3:v=1:a=0",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.12*sin(2*PI*if(lt(t\\,1)\\,440\\,if(lt(t\\,2)\\,880\\,1320))*t):s=48000:d=3",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    scenes,
  ]);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function render(
  name: string,
  settings: Partial<RemixSettings> = {},
  extras: {
    input?: string;
    audioPath?: string;
    subtitlePath?: string;
    supportingVisuals?: SupportingVisual[];
  } = {},
) {
  const input = extras.input ?? landscape;
  const output = path.join(directory, `${name}.mp4`);
  const progress: number[] = [];
  const workDir = path.join(directory, `${name}-work`);
  await renderVideo({
    input,
    output,
    source: await probeMedia(input),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    workDir,
    onProgress: (value) => progress.push(value),
    signal: new AbortController().signal,
    audioPath: extras.audioPath,
    subtitlePath: extras.subtitlePath,
    supportingVisuals: extras.supportingVisuals,
  });
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 100);
  assert.ok(
    progress.every(
      (value, index) => index === 0 || value >= progress[index - 1]!,
    ),
  );
  assert.deepEqual(
    await readdir(workDir),
    [],
    "Temporary text/subtitle files are removed",
  );
  return { output, info: await probeMedia(output) };
}

test("probes real video/audio and creates a usable thumbnail", async () => {
  const info = await probeMedia(landscape);
  assert.deepEqual(
    {
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio,
    },
    { width: 320, height: 180, fps: 24, hasAudio: true },
  );
  assert.ok(Math.abs(info.duration - 2) < 0.1);
  assert.equal((await probeMedia(portrait)).hasAudio, false);
  assert.ok(Math.abs((await probeAudio(audio)) - 0.3) < 0.02);
  const thumbnail = path.join(directory, "thumbnail.jpg");
  await createThumbnail(landscape, thumbnail);
  assert.ok((await stat(thumbnail)).size > 100);
  assert.equal(
    (await readFile(thumbnail)).subarray(0, 2).toString("hex"),
    "ffd8",
  );
});

test("rejects corrupt files, audio-only video uploads, and disguised local playlists", async () => {
  const corrupt = path.join(directory, "corrupt.mp4");
  await writeFile(corrupt, "definitely not a video");
  await assert.rejects(probeMedia(corrupt));
  await assert.rejects(probeMedia(audio), /video stream/);
  await assert.rejects(probeAudio(portrait), /playable audio/);
  const playlist = path.join(directory, "playlist.mp4");
  await writeFile(playlist, "ffconcat version 1.0\nfile 'portrait.mp4'\n");
  await assert.rejects(probeMedia(playlist), /whitelist|Invalid data/);
});

test("renders every visual control, arbitrary hook text, and burned subtitles with exact trim/speed geometry", async () => {
  const subtitles = path.join(directory, "user's captions.srt");
  await writeFile(
    subtitles,
    "1\n00:00:00,000 --> 00:00:00,800\nA useful new story.\n\n",
  );
  const { info } = await render(
    "all-controls",
    {
      trimStart: 0.25,
      trimEnd: 1.75,
      timeShift: 0.3,
      speed: 1.5,
      volume: 0.7,
      zoom: 1.1,
      saturation: 1.2,
      brightness: 0.04,
      contrast: 1.1,
      hue: -30,
      gamma: 1.1,
      temperature: -0.2,
      noise: 0.1,
      sharpness: 0.5,
      blend: 0.3,
      frameBlend: 0.12,
      mirror: true,
      aspect: "4:5",
      fit: "crop",
      resolution: "720",
      fps: "30",
      hookText:
        "100% original? 'quotes': [brackets], \\ backslash; %{localtime} $(touch nope) `echo nope`",
      hookDuration: 0.5,
      device: "iPhone 17 Pro",
    },
    { subtitlePath: subtitles },
  );
  assert.deepEqual(
    [info.width, info.height, info.fps, info.hasAudio],
    [144, 180, 30, true],
  );
  assert.ok(
    Math.abs(info.duration - 1) < 0.06,
    `Expected 1s output, got ${info.duration}`,
  );
});

test("preserves silent inputs, supports explicit mute, and does not upscale for a resolution cap", async () => {
  const silent = await render(
    "silent",
    { resolution: "1080" },
    { input: portrait },
  );
  assert.deepEqual(
    [silent.info.width, silent.info.height, silent.info.hasAudio],
    [180, 320, false],
  );
  const muted = await render("muted", { muted: true, speed: 2, aspect: "1:1" });
  assert.deepEqual(
    [muted.info.width, muted.info.height, muted.info.hasAudio],
    [180, 180, false],
  );
  assert.ok(Math.abs(muted.info.duration - 1) < 0.06);
});

test("contain export pads the image into requested geometry", async () => {
  const { output, info } = await render("contain", {
    aspect: "9:16",
    fit: "contain",
    muted: true,
  });
  assert.deepEqual([info.width, info.height], [320, 568]);
  const raw = await ffmpeg([
    "-i",
    output,
    "-frames:v",
    "1",
    "-vf",
    "format=gray",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  const topAverage =
    raw.subarray(0, info.width * 30).reduce((sum, pixel) => sum + pixel, 0) /
    (info.width * 30);
  const centerAverage =
    raw
      .subarray(info.width * 280, info.width * 290)
      .reduce((sum, pixel) => sum + pixel, 0) /
    (info.width * 10);
  assert.ok(topAverage < 5, `Bars should be black, got ${topAverage}`);
  assert.ok(centerAverage > 30, "The middle must contain the source picture");
});

async function samples(file: string): Promise<Float32Array> {
  const buffer = await ffmpeg([
    "-i",
    file,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "f32le",
    "pipe:1",
  ]);
  return new Float32Array(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
}

function frequency(values: Float32Array): number {
  let crossings = 0;
  for (let index = 1; index < values.length; index++)
    if (values[index - 1]! <= 0 && values[index]! > 0) crossings++;
  return (crossings * 48000) / values.length;
}

function rms(values: Float32Array): number {
  return Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0) / values.length,
  );
}

test("speed changes preserve source pitch and volume changes affect actual audio samples", async () => {
  const normal = await render("normal-audio");
  const quiet = await render("quiet-fast-audio", { speed: 2, volume: 0.2 });
  const [normalSamples, quietSamples] = await Promise.all([
    samples(normal.output),
    samples(quiet.output),
  ]);
  assert.ok(
    Math.abs(frequency(quietSamples) - 440) < 15,
    "Source pitch stays around 440Hz at double speed",
  );
  assert.ok(
    rms(quietSamples) / rms(normalSamples) > 0.16 &&
      rms(quietSamples) / rms(normalSamples) < 0.24,
    "0.2 volume should give approximately one fifth RMS amplitude",
  );
});

test("replacement audio loops to fill silent footage and stays at its own playback speed", async () => {
  const { output, info } = await render(
    "replacement",
    { speed: 0.5 },
    { input: portrait, audioPath: audio },
  );
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs(info.duration - 4) < 0.06);
  const values = await samples(output);
  assert.ok(
    values.length / 48000 >= 3.95,
    "Short replacement audio fills the entire output",
  );
  assert.ok(
    Math.abs(frequency(values) - 880) < 15,
    "Replacement music/voice stays at 880Hz",
  );
  assert.ok(
    rms(values.subarray(values.length - 12000)) > 0.01,
    "The last quarter second is not silent padding",
  );
});

test("rotation metadata is respected once and stripped from rendered display orientation", async () => {
  const rotated = path.join(directory, "rotated.mp4");
  await ffmpeg([
    "-display_rotation",
    "90",
    "-i",
    landscape,
    "-c",
    "copy",
    rotated,
  ]);
  assert.deepEqual(
    [(await probeMedia(rotated)).width, (await probeMedia(rotated)).height],
    [180, 320],
  );
  const { info } = await render("rotated-export", {}, { input: rotated });
  assert.deepEqual([info.width, info.height], [180, 320]);
});

test("metadata stripping works and legacy device profiles never invent camera metadata", async () => {
  const stripped = await render("stripped-metadata", {
    device: "iPhone 17 Pro",
  });
  const retained = await render("retained-metadata", { stripMetadata: false });
  const readMetadata = async (file: string) =>
    (await ffmpeg(["-i", file, "-f", "ffmetadata", "pipe:1"])).toString("utf8");
  const [strippedText, retainedText] = await Promise.all([
    readMetadata(stripped.output),
    readMetadata(retained.output),
  ]);
  assert.ok(
    !strippedText.includes("private source title"),
    "Source title should be removed",
  );
  assert.ok(
    !/make=|model=|iPhone|Apple|comment=/i.test(strippedText),
    "Legacy device profile never injects capture metadata",
  );
  assert.ok(
    retainedText.includes("title=private source title"),
    "Keeping metadata retains source title",
  );
});

test("B-roll cutaways follow the edited timeline, preserve source audio, and return cleanly to the main footage", async () => {
  const { output, info } = await render(
    "cutaway-timing",
    {
      segments: [{ start: 0, end: 1.5 }],
      speed: 0.5,
      fps: "30",
    },
    {
      input: scenes,
      supportingVisuals: [
        {
          path: scenes,
          start: 0.75,
          end: 1.5,
          sourceStart: 2.1,
          kind: "broll",
          label: "Blue detail",
        },
      ],
    },
  );
  assert.ok(Math.abs(info.duration - 3) < 0.05);
  const sound = await samples(output);
  for (const [time, dominant, tone] of [
    [0.7, 0, 440],
    [0.85, 2, 440],
    [1.4, 2, 440],
    [1.55, 0, 440],
    [2.5, 1, 880],
  ]) {
    const pixel = await ffmpeg([
      "-ss",
      String(time),
      "-i",
      output,
      "-frames:v",
      "1",
      "-vf",
      "scale=1:1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    assert.ok(
      pixel[dominant!]! > 180,
      `Expected channel ${dominant} at ${time}s; got ${Array.from(pixel)}`,
    );
    const measured = frequency(
      sound.subarray(
        Math.round((time! - 0.035) * 48000),
        Math.round((time! + 0.035) * 48000),
      ),
    );
    assert.ok(
      Math.abs(measured - tone!) < 35,
      `Original audio should remain ${tone}Hz at ${time}s; got ${measured}`,
    );
  }
});

test("cutaways keep replacement narration and subtitles above the supporting picture", async () => {
  const subtitles = path.join(directory, "cutaway-captions.srt");
  await writeFile(
    subtitles,
    "1\n00:00:00,200 --> 00:00:01,700\nWords stay readable.\n",
  );
  const { output, info } = await render(
    "cutaway-narration",
    { hookText: "Keep this hook", hookDuration: 2 },
    {
      input: portrait,
      audioPath: audio,
      subtitlePath: subtitles,
      supportingVisuals: [
        {
          path: scenes,
          start: 0.25,
          end: 1.15,
          sourceStart: 2.05,
          kind: "graphic",
          label: "Blue idea",
        },
      ],
    },
  );
  assert.deepEqual([info.width, info.height, info.hasAudio], [180, 320, true]);
  assert.ok(Math.abs(frequency(await samples(output)) - 880) < 20);
  const raw = await ffmpeg([
    "-ss",
    "0.7",
    "-i",
    output,
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  let whiteTop = 0;
  let whiteBottom = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      if (raw[i]! > 180 && raw[i + 1]! > 180 && raw[i + 2]! > 180) {
        if (y < info.height * 0.25) whiteTop++;
        if (y > info.height * 0.65) whiteBottom++;
      }
    }
  assert.ok(whiteTop > 30, "Hook remains above the cutaway");
  assert.ok(whiteBottom > 30, "Captions remain above the cutaway");
});

test("cutaway validation rejects out-of-bounds intervals and disguised playlists", async () => {
  const base = {
    path: scenes,
    start: 0.5,
    end: 1.5,
    kind: "broll" as const,
    label: "Detail",
  };
  await assert.rejects(
    render(
      "cutaway-too-late",
      {},
      { supportingVisuals: [{ ...base, end: 3 }] },
    ),
    /within the edited video/,
  );
  await assert.rejects(
    render(
      "cutaway-too-short",
      {},
      { supportingVisuals: [{ ...base, sourceStart: 2.5 }] },
    ),
    /shorter than/,
  );
  const playlist = path.join(directory, "supporting-playlist.mp4");
  await writeFile(playlist, "ffconcat version 1.0\nfile 'portrait.mp4'\n");
  await assert.rejects(
    render(
      "cutaway-playlist",
      {},
      { supportingVisuals: [{ ...base, path: playlist }] },
    ),
    /whitelist|Invalid data/,
  );
});

test("rejects disguised playlists and malformed cues in subtitle attachments", async () => {
  const subtitles = path.join(directory, "disguised.srt");
  await writeFile(
    subtitles,
    "ffconcat version 1.0\nfile 'portrait.mp4'\n# 00:00:00,000 --> 00:00:01,000\n",
  );
  await assert.rejects(
    render("disguised-subtitles", {}, { subtitlePath: subtitles }),
    /Every SRT cue/,
  );
  await writeFile(
    subtitles,
    "1\n00:00:02,000 --> 00:00:01,000\nBackwards timestamp.\n",
  );
  await assert.rejects(
    render("backwards-subtitles", {}, { subtitlePath: subtitles }),
    /Subtitle end/,
  );
});

test("rejects invalid trim/settings and cancellation removes partial output", async () => {
  await assert.rejects(render("bad-trim", { trimStart: 3 }), /Select at least/);
  await assert.rejects(render("bad-speed", { speed: 0 }), /Invalid speed/);
  const output = path.join(directory, "cancelled.mp4");
  const controller = new AbortController();
  const source = await probeMedia(landscape);
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(
      renderVideo({
        input: landscape,
        output,
        source,
        settings: {
          ...DEFAULT_SETTINGS,
          speed: 0.5,
          noise: 1,
          frameBlend: 0.5,
          segments: [{ start: 0.2, end: 1.8 }],
          callouts: [{ text: "Cancel this edit", start: 0, end: 1 }],
        },
        workDir: path.join(directory, "cancel-work"),
        signal: controller.signal,
        onProgress() {},
      }),
      { name: "AbortError" },
    );
    await assert.rejects(stat(output), { code: "ENOENT" });
    assert.deepEqual(await readdir(path.join(directory, "cancel-work")), []);
  } finally {
    clearTimeout(timer);
  }
});

test("ordered source clips remove gaps, repeat overlapping footage, and keep source audio aligned after speed changes", async () => {
  const { output, info } = await render(
    "ordered-clips",
    {
      segments: [
        { start: 2.2, end: 2.8 },
        { start: 0.2, end: 0.8 },
        { start: 1.2, end: 1.8 },
        { start: 0.4, end: 0.7 },
      ],
      speed: 1.5,
      trimStart: 2,
      trimEnd: 2.1,
      timeShift: 5,
    },
    { input: scenes },
  );
  assert.ok(
    Math.abs(info.duration - 1.4) <= 0.04,
    `Expected 1.4s edit; got ${info.duration}`,
  );
  const sound = await samples(output);
  for (const [time, dominant, tone] of [
    [0.1, 2, 1320],
    [0.5, 0, 440],
    [0.9, 1, 880],
    [1.3, 0, 440],
  ]) {
    const pixel = await ffmpeg([
      "-ss",
      String(time),
      "-i",
      output,
      "-frames:v",
      "1",
      "-vf",
      "scale=1:1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    assert.ok(
      pixel[dominant!]! > 180,
      `Clip at ${time}s has expected RGB channel ${dominant}`,
    );
    for (let channel = 0; channel < 3; channel++)
      if (channel !== dominant) assert.ok(pixel[channel]! < 60);
    const measured = frequency(
      sound.subarray(
        Math.round((time! - 0.035) * 48000),
        Math.round((time! + 0.035) * 48000),
      ),
    );
    assert.ok(
      Math.abs(measured - tone!) < 35,
      `Audio at ${time}s should be ${tone}Hz, got ${measured}`,
    );
  }
});

test("blur framing fills portrait bars while timed callouts and automatic motion remain renderable", async () => {
  const { output, info } = await render(
    "blur-auto",
    {
      aspect: "9:16",
      fit: "blur",
      autoMotion: true,
      normalizeAudio: true,
      segments: [{ start: 0, end: 1 }],
      callouts: [
        {
          text: "A new angle: 'quotes' %{localtime} \\ [safe]",
          start: 0.3,
          end: 0.8,
        },
      ],
    },
    { input: scenes },
  );
  assert.deepEqual([info.width, info.height, info.hasAudio], [320, 568, true]);
  const first = await ffmpeg([
    "-i",
    output,
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  assert.ok(
    first[0]! > 60,
    "Blur fill retains scene color instead of black bars",
  );
  const center =
    (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
  assert.ok(
    first[center]! > 180,
    "The centered source retains its full picture",
  );
  const baseline = await render(
    "callout-baseline",
    { segments: [{ start: 0, end: 1 }], muted: true },
    { input: scenes },
  );
  const callout = await render(
    "callout-timing",
    {
      segments: [{ start: 0, end: 1 }],
      muted: true,
      callouts: [{ text: "A visible caption", start: 0.3, end: 0.8 }],
    },
    { input: scenes },
  );
  const frame = (file: string, time: number) =>
    ffmpeg([
      "-ss",
      String(time),
      "-i",
      file,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
  for (const time of [0.1, 0.5, 0.9]) {
    const [plain, captioned] = await Promise.all([
      frame(baseline.output, time),
      frame(callout.output, time),
    ]);
    const different = plain.reduce(
      (sum, value, index) =>
        sum + (Math.abs(value - captioned[index]!) > 35 ? 1 : 0),
      0,
    );
    if (time === 0.5)
      assert.ok(different > 500, "Callout is visible within its time window");
    else
      assert.ok(different < 100, "Callout is absent outside its time window");
  }
});

test("normalization raises quiet audio and cuts also support replacement audio or silent inputs", async () => {
  const normal = await render("normalize-base");
  const normalized = await render("normalize-enabled", {
    normalizeAudio: true,
    autoMotion: true,
  });
  const [beforeSamples, afterSamples] = await Promise.all([
    samples(normal.output),
    samples(normalized.output),
  ]);
  assert.ok(
    rms(afterSamples) > rms(beforeSamples) * 1.3,
    "Loudness normalization raises the quiet source toward -16 LUFS",
  );
  const silent = await render(
    "silent-cuts",
    {
      segments: [
        { start: 1, end: 1.8 },
        { start: 0.1, end: 0.5 },
      ],
    },
    { input: portrait },
  );
  assert.equal(silent.info.hasAudio, false);
  const replacement = await render(
    "replacement-cuts",
    {
      segments: [
        { start: 1, end: 1.8 },
        { start: 0.1, end: 0.5 },
      ],
      speed: 2,
      normalizeAudio: true,
    },
    { input: portrait, audioPath: audio },
  );
  assert.ok(Math.abs(replacement.info.duration - 0.6) < 0.05);
  assert.ok(
    Math.abs(frequency(await samples(replacement.output)) - 880) < 30,
    "Replacement track stays on final timeline at its original pitch",
  );
  await assert.rejects(
    render("invalid-cuts", { segments: [{ start: 0, end: 5 }] }),
    /within the video/,
  );
  await assert.rejects(
    render("empty-cuts", { segments: [] }),
    /valid source clips/,
  );
});
