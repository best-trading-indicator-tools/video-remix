import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { burnOutputCaptions, probeMedia, renderVideo } from "../server/engine.js";
import { assertCleanExportMetadata, type ExportMetadata } from "../server/export-metadata.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

const exec = promisify(execFile);
const ffmpeg = (...args: string[]) => exec("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
const metadata = async (file: string): Promise<ExportMetadata> => JSON.parse((await exec("ffprobe", [
  "-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", file,
])).stdout);
let directory: string, input: string, subtitles: string;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "export-metadata-"));
  input = path.join(directory, "tagged source.mp4");
  subtitles = path.join(directory, "captions.srt");
  const chapters = path.join(directory, "chapters.txt");
  await writeFile(subtitles, "1\n00:00:00,000 --> 00:00:01,000\nTest caption\n");
  await writeFile(chapters, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=AI_TEST_CHAPTER\n");
  await ffmpeg("-f", "lavfi", "-i", "color=0x153040:s=320x180:r=24:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-f", "ffmetadata", "-i", chapters,
    "-map", "0:v:0", "-map", "1:a:0", "-map_chapters", "2",
    "-c:v", "libx264", "-threads", "1", "-c:a", "aac",
    "-metadata", "title=AI_TEST_TITLE", "-metadata", "comment=AI_TEST_COMMENT",
    "-metadata", "c2pa=AI_TEST_PROVENANCE_TAG", "-metadata", "ai_generated=AI_TEST_GENERATOR",
    "-metadata", "creation_time=2026-01-01T00:00:00Z",
    "-metadata:s:v:0", "handler_name=AI_TEST_VIDEO_HANDLER",
    "-metadata:s:a:0", "handler_name=AI_TEST_AUDIO_HANDLER",
    "-metadata:s:a:0", "language=eng",
    "-bsf:v", "h264_metadata=sei_user_data=0123456789abcdef0123456789abcdef+AI_TEST_SEI",
    "-movflags", "+use_metadata_tags", input);
  // Opaque MP4 UUID payload: proves re-encoding does not copy unknown boxes.
  // This is a synthetic fixture, not a signed C2PA credential or pixel watermark.
  const payload = Buffer.from("AI_TEST_CONTAINER_PAYLOAD");
  const box = Buffer.alloc(24 + payload.length);
  box.writeUInt32BE(box.length, 0); box.write("uuid", 4, "ascii");
  Buffer.from("0123456789abcdef0123456789abcdef", "hex").copy(box, 8);
  payload.copy(box, 24);
  await appendFile(input, box);
  const original = await metadata(input), bytes = await readFile(input);
  assert.equal(original.format?.tags?.c2pa, "AI_TEST_PROVENANCE_TAG");
  assert.equal(original.chapters?.length, 1);
  assert.ok(original.streams?.some(stream => stream.tags?.handler_name === "AI_TEST_AUDIO_HANDLER"));
  for (const marker of ["AI_TEST_SEI", "AI_TEST_CONTAINER_PAYLOAD"]) assert.ok(bytes.includes(Buffer.from(marker)));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function assertCleanFile(file: string, audio: boolean) {
  const info = await metadata(file);
  assert.deepEqual(Object.keys(info.format?.tags ?? {}).sort(), ["compatible_brands", "major_brand", "minor_version"]);
  assert.deepEqual(info.streams?.map(stream => stream.codec_type), audio ? ["video", "audio"] : ["video"]);
  assert.equal(info.chapters?.length, 0);
  for (const stream of info.streams ?? []) {
    assert.equal(stream.tags?.language, "und");
    assert.equal(stream.tags?.handler_name, stream.codec_type === "video" ? "VideoHandler" : "SoundHandler");
    assert.equal(stream.tags?.encoder, undefined);
    assert.equal(stream.tags?.creation_time, undefined);
  }
  assert.ok(!(await readFile(file)).includes(Buffer.from("AI_TEST_")), "No source metadata, UUID payload, or unregistered SEI survived");
}

test("all rendered exports clean source tags, chapters, container payloads and SEI", { timeout: 60000 }, async t => {
  const source = await probeMedia(input);
  for (const mode of ["default", "legacy-keep-metadata", "muted", "preview"] as const) await t.test(mode, async () => {
    const output = path.join(directory, `${mode}.mp4`);
    await renderVideo({ input, output, source, settings: { ...DEFAULT_SETTINGS, stripMetadata: mode !== "legacy-keep-metadata", muted: mode === "muted" },
      maximumOutputDuration: mode === "preview" ? 0.5 : undefined,
      workDir: path.join(directory, "work"), signal: new AbortController().signal, onProgress: () => {} });
    await assertCleanFile(output, mode !== "muted");
  });
});

test("final captioning cleans tagged input metadata while preserving AAC packets", { timeout: 30000 }, async () => {
  const output = path.join(directory, "captioned.mp4");
  await burnOutputCaptions({ input, output, subtitlePath: subtitles, workDir: path.join(directory, "caption-work"), signal: new AbortController().signal });
  await assertCleanFile(output, true);
  const packets = async (file: string) => (await ffmpeg("-i", file, "-map", "0:a:0", "-c:a", "copy", "-f", "adts", "pipe:1")).stdout;
  assert.deepEqual(await packets(output), await packets(input));
});

test("the final metadata guard rejects unexpected tags, chapters and tracks", () => {
  const clean = (): ExportMetadata => ({ format: { tags: { major_brand: "isom", minor_version: "512", compatible_brands: "isomiso2avc1mp41" } },
    streams: [{ codec_type: "video", tags: { handler_name: "VideoHandler", language: "und", vendor_id: "[0][0][0][0]" } }], chapters: [] });
  assert.doesNotThrow(() => assertCleanExportMetadata(clean()));
  for (const modify of [
    (info: ExportMetadata) => { info.format!.tags!.c2pa = "PRIVATE_VALUE"; },
    (info: ExportMetadata) => { info.streams![0]!.tags!.encoder = "PRIVATE_VALUE"; },
    (info: ExportMetadata) => { info.streams![0]!.tags!.handler_name = "PRIVATE_VALUE"; },
    (info: ExportMetadata) => { info.streams![0]!.tags!.language = "eng"; },
    (info: ExportMetadata) => { info.streams![0]!.disposition = { attached_pic: 1 }; },
    (info: ExportMetadata) => { info.streams!.push({ codec_type: "data" }); },
    (info: ExportMetadata) => { info.streams!.push({ codec_type: "subtitle" }); },
    (info: ExportMetadata) => { info.chapters = [{ tags: { title: "PRIVATE_VALUE" } }]; },
    (info: ExportMetadata) => { info.streams = []; },
  ]) {
    const dirty = clean(); modify(dirty);
    assert.throws(() => assertCleanExportMetadata(dirty), error => error instanceof Error
      && /metadata verification failed/.test(error.message) && !error.message.includes("PRIVATE_VALUE"));
  }
});
