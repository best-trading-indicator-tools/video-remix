import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EditSegment, Transcript } from "../shared/types.js";
import { MEDIA_INPUT_ARGS, runLocal } from "./auto-process.js";
import { paths } from "./config.js";

export interface SourceCaptionInspection {
  status: "detected" | "not-detected" | "uncertain" | "unavailable";
  sampledFrames: number;
  reason?: string;
}
interface Source { filePath: string; fingerprint?: string; size: number; duration: number }
interface Window { start: number; end: number }
interface Line { text: string; tokens: string[]; x: number; y: number; width: number; height: number; confidence: number }
interface Sample { time: number; lines: Line[] }
const VERSION = 1;
const MAX_FRAMES = 12;
const BUDGET_MS = 35_000;
const languages: Record<string, string> = { en: "eng", fr: "fra", es: "spa", de: "deu", it: "ita", pt: "por", nl: "nld",
  ru: "rus", uk: "ukr", pl: "pol", tr: "tur", ar: "ara", hi: "hin", ja: "jpn", ko: "kor", zh: "chi_sim",
  ca: "cat", sv: "swe", da: "dan", no: "nor", fi: "fin", cs: "ces", el: "ell", he: "heb", vi: "vie", id: "ind", ro: "ron", hu: "hun" };

const words = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase()
  .match(/[\p{L}\p{N}]{2,}/gu) || [];
function overlap(a: string[], b: string[]) {
  const left = new Set(a), right = new Set(b);
  const count = [...left].filter(word => right.has(word)).length;
  return count / Math.max(1, left.size + right.size - count);
}
function sampleTimes(cuts: EditSegment[], transcript?: Transcript): number[] {
  const speech: Window[] = [];
  for (const cut of cuts) {
    const pieces: Window[] = [];
    for (const segment of transcript?.segments || []) {
      if (segment.end <= cut.start || segment.start >= cut.end) continue;
      const spans = segment.words.length ? segment.words : [segment];
      for (const word of spans) {
        const start = Math.max(cut.start, word.start), end = Math.min(cut.end, word.end);
        if (end - start > 0.025) pieces.push({ start, end });
      }
    }
    // Merge overlapping word/segment times only within this selected cut.
    const merged: Window[] = [];
    for (const piece of pieces.sort((a, b) => a.start - b.start)) {
      const previous = merged.at(-1);
      if (previous && piece.start <= previous.end) previous.end = Math.max(previous.end, piece.end);
      else merged.push({ ...piece });
    }
    speech.push(...merged);
  }
  const windows: Window[] = speech.length ? speech : cuts;
  const total = windows.reduce((sum, window) => sum + window.end - window.start, 0);
  const times: number[] = [];
  for (let index = 0; index < MAX_FRAMES; index++) {
    let position = total * (index + 0.5) / MAX_FRAMES;
    for (const window of windows) {
      const duration = window.end - window.start;
      if (position < duration) {
        const time = Math.max(window.start + Math.min(0.01, duration / 4), Math.min(window.end - Math.min(0.01, duration / 4), window.start + position));
        if (times.every(other => Math.abs(other - time) > 0.06)) times.push(time);
        break;
      }
      position -= duration;
    }
  }
  return times;
}

function readLines(tsv: string, width: number, height: number): Line[] {
  const rows: { text: string; x: number; y: number; width: number; height: number; confidence: number }[] = [];
  const lines = tsv.trim().split(/\r?\n/u);
  if (!lines[0]?.startsWith("level\t")) throw new Error("Invalid OCR output");
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    if (fields[0] !== "5" || fields.length < 12) continue;
    const [x, y, w, h, confidence] = fields.slice(6, 11).map(Number);
    const text = fields.slice(11).join(" ").trim();
    if (![x, y, w, h, confidence].every(Number.isFinite) || confidence! < 50 || !words(text).length || w! <= 0 || h! <= 0 ||
      x! < 0 || y! < 0 || x! + w! > width + 2 || y! + h! > height + 2 || h! / height < 0.015 || h! / height > 0.16) continue;
    rows.push({ text, x: x! / width, y: y! / height, width: w! / width, height: h! / height, confidence: confidence! });
  }
  const groups: typeof rows[] = [];
  for (const word of rows.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const group = groups.find(group => Math.abs(group[0]!.y + group[0]!.height / 2 - word.y - word.height / 2) < Math.max(group[0]!.height, word.height) * 0.55);
    if (group) group.push(word); else groups.push([word]);
  }
  const merged = groups.map(group => {
    group.sort((a, b) => a.x - b.x);
    const x = Math.min(...group.map(word => word.x)), y = Math.min(...group.map(word => word.y));
    const text = group.map(word => word.text).join(" ");
    return { text, tokens: words(text), x, y, width: Math.max(...group.map(word => word.x + word.width)) - x,
      height: Math.max(...group.map(word => word.y + word.height)) - y,
      confidence: group.reduce((sum, word) => sum + word.confidence, 0) / group.length };
  });
  // A two-line caption can change which line is longest while keeping its band.
  const combined: Line[] = [];
  for (let index = 0; index < merged.length - 1; index++) {
    const a = merged[index]!, b = merged[index + 1]!;
    if (b.y - a.y - a.height > Math.max(a.height, b.height) * 1.2 ||
      Math.abs(a.x + a.width / 2 - b.x - b.width / 2) > 0.15) continue;
    combined.push({ text: `${a.text} ${b.text}`, tokens: [...a.tokens, ...b.tokens], x: Math.min(a.x, b.x), y: a.y,
      width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: b.y + b.height - a.y,
      confidence: (a.confidence + b.confidence) / 2 });
  }
  return [...merged, ...combined].filter(line => line.tokens.length >= 2 && line.text.length >= 7 && line.width >= 0.12 && line.confidence >= 65 ||
    line.tokens.length === 1 && line.text.length >= 4 && line.width >= 0.06 && line.height >= 0.025 && line.confidence >= 75);
}
function nearbyWords(transcript: Transcript | undefined, time: number) {
  return (transcript?.segments || []).flatMap(segment => {
    if (segment.end < time - 1.5 || segment.start > time + 1.5) return [];
    if (!segment.words.length) return words(segment.text);
    return segment.words.flatMap(word => word.end >= time - 1.5 && word.start <= time + 1.5 ? words(word.word) : []);
  });
}
function classify(samples: Sample[], transcript?: Transcript, failures = 0): SourceCaptionInspection {
  const bands: { x: number; y: number; observations: Map<number, Line> }[] = [];
  for (const [frame, sample] of samples.entries()) for (const line of sample.lines) {
    const x = line.x + line.width / 2, y = line.y + line.height / 2;
    let band = bands.find(band => Math.abs(band.y - y) <= 0.075 && Math.abs(band.x - x) <= 0.16);
    if (!band) { band = { x, y, observations: new Map() }; bands.push(band); }
    const previous = band.observations.get(frame);
    if (!previous || line.tokens.length > previous.tokens.length) band.observations.set(frame, line);
  }
  let changingText = false;
  let matchingStaticText = false;
  for (const band of bands) {
    const distinct: { tokens: string[]; count: number; matches: number }[] = [];
    let matched = 0;
    for (const [frame, line] of band.observations) {
      const context = new Set(nearbyWords(transcript, samples[frame]!.time));
      const lineWords = [...new Set(line.tokens)];
      const common = lineWords.filter(word => context.has(word)).length;
      const agrees = common >= Math.min(2, lineWords.length) && common / lineWords.length >= 0.55;
      if (agrees) matched++;
      let group = distinct.find(group => overlap(group.tokens, line.tokens) >= 0.72);
      if (!group) { group = { tokens: line.tokens, count: 0, matches: 0 }; distinct.push(group); }
      group.count++; if (agrees) group.matches++;
    }
    if (distinct.length > 1 && band.observations.size >= 3) changingText = true;
    const singleWordsOnly = [...band.observations.values()].every(line => line.tokens.length === 1);
    if (matched >= 3 && distinct.length === 1) matchingStaticText = true;
    if (band.observations.size >= 3 && matched >= (singleWordsOnly ? 4 : 3) && matched >= band.observations.size / 2 &&
      distinct.filter(group => group.matches).length >= (singleWordsOnly ? 3 : 2))
      return { status: "detected", sampledFrames: samples.length, reason: "Changing on-screen text in a stable position matches the nearby spoken words." };
    if (!singleWordsOnly && !transcript?.segments.length && band.observations.size >= Math.max(6, Math.ceil(samples.length * 0.6)) &&
      distinct.filter(group => group.count >= 2).length >= 3)
      return { status: "detected", sampledFrames: samples.length, reason: "Several changing phrases repeatedly occupy the same on-screen caption area." };
  }
  if (failures || samples.length < 8 || changingText || matchingStaticText)
    return { status: "uncertain", sampledFrames: samples.length,
      reason: failures ? "Some selected frames could not be checked. Existing captions may still be present." :
        samples.length < 8 ? "Too few distinct frames were available to determine whether captions are already present." :
          matchingStaticText ? "On-screen text matches the speech but does not change within this short selection. It may already be a caption." :
            "Changing on-screen text was found, but there was not enough evidence to identify it as speech captions." };
  return { status: "not-detected", sampledFrames: samples.length,
    reason: bands.length ? "Only unchanged or isolated text was found in the sampled frames; no changing speech captions were detected." :
      "No readable caption text was found in the sampled frames. This sample does not establish that the entire video has no captions." };
}

/** Local, bounded evidence about the exact selected source intervals; never a cloud call. */
export async function inspectSourceCaptions({ source, cuts, transcript, signal, cacheDir = path.join(paths.analysis, "source-captions") }: {
  source: Source; cuts: EditSegment[]; transcript?: Transcript; signal: AbortSignal; cacheDir?: string;
}): Promise<SourceCaptionInspection> {
  signal.throwIfAborted();
  if (!Number.isFinite(source.duration) || source.duration <= 0 || !Number.isFinite(source.size) || source.size <= 0 ||
    !cuts.length || cuts.length > 60 || cuts.some(cut => !Number.isFinite(cut.start) || !Number.isFinite(cut.end) ||
      cut.start < 0 || cut.end - cut.start < 0.04 || cut.end > source.duration + 0.001))
    return { status: "uncertain", sampledFrames: 0, reason: "The selected source intervals could not be checked." };
  const budget = AbortSignal.any([signal, AbortSignal.timeout(BUDGET_MS)]);
  let directory: string | undefined;
  const samples: Sample[] = [];
  try {
    const filePath = await realpath(source.filePath);
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== source.size)
      return { status: "uncertain", sampledFrames: 0, reason: "The source file changed or could not be read reliably." };
    const selectedTranscript = transcript ? { language: transcript.language, segments: transcript.segments.filter(segment =>
      cuts.some(cut => segment.end >= cut.start - 1.5 && segment.start <= cut.end + 1.5)) } : undefined;
    const identity = createHash("sha256").update(JSON.stringify({ version: VERSION,
      source: source.fingerprint || { filePath, size: info.size, modified: info.mtimeMs, device: info.dev, inode: info.ino },
      size: source.size, duration: source.duration, cuts: cuts.map(cut => ({ start: cut.start, end: cut.end })), transcript: selectedTranscript,
    })).digest("hex");
    const destination = path.join(cacheDir, `${identity}.json`);
    try {
      const cached = JSON.parse(await readFile(destination, "utf8"));
      signal.throwIfAborted();
      if (cached.identity === identity && ["detected", "not-detected"].includes(cached.result?.status) &&
        Number.isInteger(cached.result.sampledFrames) && cached.result.sampledFrames >= 1 && cached.result.sampledFrames <= MAX_FRAMES &&
        (cached.result.reason === undefined || typeof cached.result.reason === "string" && cached.result.reason.length <= 400)) return cached.result;
    } catch { signal.throwIfAborted(); }
    let available: Set<string>;
    try {
      const result = await runLocal("tesseract", ["--list-langs"], { signal: budget, timeout: 4000 });
      available = new Set(`${result.stdout}\n${result.stderr}`.split(/\r?\n/u).map(line => line.trim()));
    } catch {
      signal.throwIfAborted();
      return { status: "unavailable", sampledFrames: 0, reason: "Local caption detection needs Tesseract OCR to be installed and available." };
    }
    const language = transcript?.language.toLowerCase().split(/[-_]/u)[0];
    const model = language ? languages[language] : "eng";
    if (!model || !available.has(model))
      return { status: "unavailable", sampledFrames: 0, reason: "The local OCR model for this video's language is not installed." };
    directory = await mkdtemp(path.join(os.tmpdir(), "remix-source-captions-"));
    let failures = 0;
    for (const [index, time] of sampleTimes(cuts, transcript).entries()) {
      budget.throwIfAborted();
      const frame = path.join(directory, `frame-${index}.png`);
      try {
        await runLocal("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1",
          ...MEDIA_INPUT_ARGS, "-ss", time.toFixed(6), "-i", filePath, "-map", "0:V:0", "-frames:v", "1", "-an", "-sn", "-dn",
          "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease,setsar=1", "-filter_threads", "1", "-threads", "1", "-update", "1", frame,
        ], { signal: budget, timeout: 5000 });
        const header = Buffer.alloc(24), handle = await open(frame, "r");
        try { await handle.read(header, 0, 24, 0); } finally { await handle.close(); }
        const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
        if (header.toString("hex", 0, 8) !== "89504e470d0a1a0a" || width < 2 || height < 2 || width > 1280 || height > 1280)
          throw new Error("Invalid sampled image");
        const { stdout } = await runLocal("tesseract", [frame, "stdout", "-l", model, "--psm", "11", "tsv"], { signal: budget, timeout: 5000 });
        samples.push({ time, lines: readLines(stdout, width, height) });
      } catch {
        signal.throwIfAborted();
        if (budget.aborted) break;
        failures++;
      } finally { await rm(frame, { force: true }).catch(() => undefined); }
    }
    signal.throwIfAborted();
    const current = await stat(filePath);
    if (current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ino !== info.ino)
      return { status: "uncertain", sampledFrames: samples.length, reason: "The source changed while its selected frames were being checked." };
    const result = classify(samples, transcript, failures + (budget.aborted ? 1 : 0));
    if (result.status === "detected" || result.status === "not-detected") {
      await mkdir(cacheDir, { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ identity, result }), { mode: 0o600, flag: "wx" });
        signal.throwIfAborted();
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    }
    return result;
  } catch {
    signal.throwIfAborted();
    return { status: samples.length ? "uncertain" : "unavailable", sampledFrames: samples.length,
      reason: budget.aborted ? "Local caption inspection exceeded its time limit. Existing captions may still be present." :
        "The selected frames could not be inspected reliably. Existing captions may still be present." };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
