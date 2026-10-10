import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { paths } from "./config.js";
import { MEDIA_INPUT_ARGS, runLocal } from "./auto-process.js";
import { validFocusTrack } from "../shared/focus.js";
import type { SpeakerFocusOptions, SpeakerFocusResult } from "./speaker-focus.js";
const parent = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = process.env.REMIX_RUNTIME_DIR || (path.basename(parent) === "dist-server" ? path.dirname(parent) : parent);
const python = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const script = path.join(root, "scripts/active_speaker.py");
const weights = path.join(root, "data/models/talknet.model");
const resultSchema = z.object({ status: z.enum(["tracked", "partial", "no-face"]), multipleFaces: z.boolean(),
  sampledFrames: z.number().int().min(0).max(3060), detectedFrames: z.number().int().min(0).max(3060), reason: z.string().max(500),
  tracks: z.array(z.object({ cutIndex: z.number().int().min(0).max(59), start: z.number(), end: z.number(), coverage: z.number().min(0).max(1),
    keyframes: z.array(z.object({ time: z.number(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(2).max(120) })).max(60) });
const unavailable = (reason: string): SpeakerFocusResult => ({ status: "unavailable", tracks: [], sampledFrames: 0, detectedFrames: 0, multipleFaces: false, reason });

export async function analyzeActiveSpeaker(options: SpeakerFocusOptions): Promise<SpeakerFocusResult> {
  const { source, cuts, seed } = options;
  options.signal.throwIfAborted();
  if (!cuts.length || cuts.length > 60 || cuts.some(cut => !Number.isFinite(cut.start) || !Number.isFinite(cut.end) || cut.start < 0 || cut.end <= cut.start || cut.end > source.duration + 0.001))
    throw new Error("Choose valid source intervals.");
  if (cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0) > 600)
    return unavailable("Free active-speaker analysis supports up to 10 minutes of selected footage per short. Use face following or select shorter sequences.");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60_000)]);
  let work: string | undefined;
  try {
    const file = await realpath(source.filePath), info = await stat(file);
    const identity = createHash("sha256").update(JSON.stringify({ version: 1, file, size: info.size, modified: info.mtimeMs, cuts, seed })).digest("hex");
    const cache = options.cacheDir || path.join(paths.analysis, "active-speaker");
    const cacheFile = path.join(cache, `${identity}.json`);
    const validate = (value: unknown): SpeakerFocusResult => {
      const result = resultSchema.parse(value);
      if (new Set(result.tracks.map(track => track.cutIndex)).size !== result.tracks.length || result.tracks.reduce((sum, track) => sum + track.keyframes.length, 0) > 240 ||
        result.detectedFrames > result.sampledFrames || result.tracks.some(track => {
          const cut = cuts[track.cutIndex]; return !cut || track.start !== cut.start || track.end !== cut.end || !validFocusTrack(track.keyframes, cut.start, cut.end);
        })) throw new Error("Invalid speaker track");
      return result;
    };
    try { return validate(JSON.parse(await readFile(cacheFile, "utf8"))); } catch { signal.throwIfAborted(); }
    try { await runLocal(python, [script, "--check", weights], { signal, timeout: 60000 }); }
    catch { signal.throwIfAborted(); return unavailable("Free active-speaker detection is not installed. Run npm run setup:speaker once, then retry. Face following remains available."); }
    await mkdir(cache, { recursive: true }); work = await mkdtemp(path.join(cache, ".analysis-"));
    const clips = [];
    for (const [cutIndex, cut] of cuts.entries()) {
      const video = path.join(work, `${cutIndex}.mp4`), audio = path.join(work, `${cutIndex}.wav`);
      const input = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "2", "-ss", String(cut.start), ...MEDIA_INPUT_ARGS, "-i", file];
      const duration = String(cut.end - cut.start);
      await runLocal("ffmpeg", [...input, "-t", duration, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "scale=w='max(2,trunc(iw*if(gt(sar,0),sar,1)*min(1,min(640/(iw*if(gt(sar,0),sar,1)),640/ih))/2)*2)':h='max(2,trunc(ih*min(1,min(640/(iw*if(gt(sar,0),sar,1)),640/ih))/2)*2)',setsar=1,fps=25", "-filter_threads", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-threads", "2", video,
        "-t", duration, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audio], { signal, timeout: 120000 });
      clips.push({ cutIndex, start: cut.start, end: cut.end, focalPoint: cut.focalPoint || seed, video, audio });
    }
    const manifest = path.join(work, "manifest.json"); await writeFile(manifest, JSON.stringify({ weights, clips, cuts, seed }));
    const raw = await runLocal(python, [script, "--manifest", manifest], { signal, timeout: 9 * 60_000 });
    signal.throwIfAborted();
    const current = await stat(file);
    if (current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ino !== info.ino) return unavailable("The original video changed during analysis. Reimport it and retry.");
    const result = validate(JSON.parse(raw.stdout));
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(result), { mode: 0o600 }); signal.throwIfAborted(); await rename(temporary, cacheFile); }
    finally { await rm(temporary, { force: true }); }
    return result;
  } catch { options.signal.throwIfAborted(); return unavailable("Active-speaker analysis could not finish on this footage. Try fewer sequences or use face following."); }
  finally { if (work) await rm(work, { recursive: true, force: true }).catch(() => {}); }
}
