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

let directory: string;
let landscape: string;
let portrait: string;
let audio: string;

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
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function render(
  name: string,
  settings: Partial<RemixSettings> = {},
  extras: { input?: string; audioPath?: string; subtitlePath?: string } = {},
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

test("metadata stripping and optional device labels affect exported metadata", async () => {
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
    strippedText.includes("model=iPhone 17 Pro"),
    "Selected device profile is stored",
  );
  assert.ok(
    retainedText.includes("title=private source title"),
    "Keeping metadata retains source title",
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
        },
        workDir: path.join(directory, "cancel-work"),
        signal: controller.signal,
        onProgress() {},
      }),
      { name: "AbortError" },
    );
    await assert.rejects(stat(output), { code: "ENOENT" });
  } finally {
    clearTimeout(timer);
  }
});
