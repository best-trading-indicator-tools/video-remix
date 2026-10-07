import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findPython } from "../scripts/setup-python.mjs";
import {
  transcribeLocal,
  transcriptionAvailable,
} from "../server/transcription.js";

function run(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(error)),
    );
  });
}
async function ffmpeg(args: string[]) {
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-threads",
    "2",
    ...args,
  ]);
}

test("transcription respects a pre-cancelled operation before touching files", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    transcribeLocal({
      input: "/does-not-exist",
      workDir: "/does-not-exist",
      signal: controller.signal,
      onProgress() {},
    }),
    { name: "AbortError" },
  );
});

test("speech readiness and setup reject an incompatible audio decoder", async (context) => {
  let python;
  try {
    python = await findPython(run, { maxMinor: null });
  } catch {
    return context.skip("Python is not installed.");
  }
  await run(python.command, [...python.args, "-c", `
import contextlib, importlib.util, io, sys, types
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("transcribe", "scripts/transcribe.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.cached_model = lambda *args: "unused-model"
runner.load_model = lambda *args: None

def broken_decoder(*args, **kwargs):
    raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")

modules = {
    "faster_whisper": types.ModuleType("faster_whisper"),
    "faster_whisper.audio": types.SimpleNamespace(decode_audio=broken_decoder),
    "faster_whisper.vad": types.SimpleNamespace(get_vad_model=lambda: None),
    "ctranslate2": types.SimpleNamespace(get_supported_compute_types=lambda _: {"int8"}),
    "onnxruntime": types.ModuleType("onnxruntime"),
}
with patch.dict(sys.modules, modules):
    for mode in ("--check", "--download"):
        output = io.StringIO()
        with patch.object(sys, "argv", ["transcribe.py", mode]), contextlib.redirect_stdout(output):
            try:
                runner.main()
            except RuntimeError as error:
                assert "setup:auto" in str(error), str(error)
                assert "metadata_errors" in str(error), str(error)
            else:
                raise AssertionError(f"{mode} accepted a broken decoder")
        assert not output.getvalue(), "A broken decoder must not report ready"
  `]);
});

test(
  "local speech model transcribes spoken words with timestamps after a silent lead-in",
  { timeout: 180000 },
  async (context) => {
    if (process.platform !== "darwin")
      return context.skip("This speech fixture uses macOS say.");
    if (!(await transcriptionAvailable()))
      return context.skip(
        "Run npm run setup:auto to install the optional local speech model.",
      );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "video-remix-speech-"),
    );
    const workDir = path.join(directory, "work");
    try {
      const spoken = path.join(directory, "spoken.aiff");
      const input = path.join(directory, "speech ' with spaces.wav");
      await run("/usr/bin/say", [
        "-v",
        "Samantha",
        "-r",
        "165",
        "-o",
        spoken,
        "A good video starts with a clear idea. Keep the useful moments, explain what matters, and give people a reason to watch.",
      ]);
      await ffmpeg([
        "-i",
        spoken,
        "-af",
        "adelay=1200:all=1,apad=pad_dur=0.8",
        "-ar",
        "16000",
        "-ac",
        "1",
        input,
      ]);
      const progress: number[] = [];
      const transcript = await transcribeLocal({
        input,
        workDir,
        signal: new AbortController().signal,
        onProgress: (value) => progress.push(value),
      });
      const text = transcript.segments
        .map((segment) => segment.text)
        .join(" ")
        .toLowerCase();
      assert.match(text, /good video/);
      assert.match(text, /useful moments/);
      assert.match(text, /reason to watch/);
      assert.equal(transcript.language, "en");
      assert.ok(transcript.segments.length > 0);
      const words = transcript.segments.flatMap((segment) => segment.words);
      assert.ok(words.length >= 15);
      assert.ok(
        words[0]!.start >= 0.8,
        "Word timestamps preserve the original silence offset.",
      );
      assert.ok(
        words.every(
          (word) =>
            word.start < word.end && word.end <= transcript.duration + 0.1,
        ),
      );
      assert.equal(progress[0], 0);
      assert.equal(progress.at(-1), 100);
      assert.ok(
        progress.every((value, i) => i === 0 || value >= progress[i - 1]!),
      );
      assert.deepEqual(
        await readdir(workDir),
        [],
        "Extracted audio is removed after success.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "silence and non-speech tones produce no invented captions",
  { timeout: 60000 },
  async (context) => {
    if (!(await transcriptionAvailable()))
      return context.skip(
        "Run npm run setup:auto to install the optional local speech model.",
      );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "video-remix-no-speech-"),
    );
    try {
      for (const [name, generator] of [
        ["silence", "anullsrc=r=16000:cl=mono"],
        [
          "tones",
          "aevalsrc=0.12*sin(2*PI*220*t)+0.12*sin(2*PI*330*t)+0.12*sin(2*PI*440*t):s=16000",
        ],
      ]) {
        const input = path.join(directory, `${name}.wav`);
        await ffmpeg(["-f", "lavfi", "-i", generator!, "-t", "3", input]);
        const transcript = await transcribeLocal({
          input,
          workDir: path.join(directory, "work"),
          signal: new AbortController().signal,
          onProgress() {},
        });
        assert.deepEqual(
          transcript.segments,
          [],
          `${name} should not invent spoken content`,
        );
        assert.equal(transcript.language, "und");
        assert.ok(Math.abs(transcript.duration - 3) < 0.05);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "transcription cancellation removes extracted audio and rejects local playlists",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "video-remix-transcribe-cancel-"),
    );
    const workDir = path.join(directory, "work");
    try {
      const input = path.join(directory, "tone.wav");
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000",
        "-t",
        "2",
        input,
      ]);
      const controller = new AbortController();
      const abortAt = (await transcriptionAvailable()) ? 7 : 5;
      await assert.rejects(
        transcribeLocal({
          input,
          workDir,
          signal: controller.signal,
          onProgress(value) {
            if (value >= abortAt) controller.abort();
          },
        }),
        { name: "AbortError" },
      );
      assert.deepEqual(await readdir(workDir), []);
      const playlist = path.join(directory, "playlist.mp4");
      await writeFile(playlist, "ffconcat version 1.0\nfile 'tone.wav'\n");
      await assert.rejects(
        transcribeLocal({
          input: playlist,
          workDir,
          signal: new AbortController().signal,
          onProgress() {},
        }),
        /whitelist|Invalid data/,
      );
      assert.deepEqual(await readdir(workDir), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
