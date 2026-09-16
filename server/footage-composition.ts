import type { OwnFootagePlacement } from "../shared/own-footage.js";
import { footageTimeline } from "../shared/own-footage.js";

export interface ResolvedFootage { placement: OwnFootagePlacement; path: string; name: string; duration: number; hasAudio: boolean }
const number = (value: number) => Number(value.toFixed(8)).toString();

/** Append timed insertions to already edited picture and sound, in the same encode. */
export async function composeFootage({ graph, footage, duration, fps, width, height, audio, volume, normalizeAudio, firstInput, addInput }: {
  graph: string[]; footage: ResolvedFootage[]; duration: number; fps: number; width: number; height: number;
  audio: boolean; volume: number; normalizeAudio: boolean; firstInput: number;
  addInput: (clip: ResolvedFootage, length: number) => Promise<void>;
}) {
  const timeline = footageTimeline(footage.map(item => item.placement), duration, fps);
  const pieces: ({ kind: "base"; start: number; end: number } | { kind: "insert"; item: typeof timeline.inserts[number] })[] = [];
  let cursor = 0;
  for (const item of timeline.inserts) {
    if (item.at > cursor + 1e-9) pieces.push({ kind: "base", start: cursor, end: item.at });
    pieces.push({ kind: "insert", item }); cursor = item.at;
  }
  if (cursor < duration) pieces.push({ kind: "base", start: cursor, end: duration });
  const bases = pieces.filter(piece => piece.kind === "base").length;
  graph.push(`[edited]${bases === 1 ? "null" : `split=${bases}`}${Array.from({ length: bases }, (_, i) => `[basev${i}]`).join("")}`);
  if (audio) graph.push(`[baseaudio]${bases === 1 ? "anull" : `asplit=${bases}`}${Array.from({ length: bases }, (_, i) => `[basea${i}]`).join("")}`);
  let baseIndex = 0, inputIndex = firstInput;
  for (const [index, piece] of pieces.entries()) {
    if (piece.kind === "base") {
      graph.push(`[basev${baseIndex}]trim=start=${number(piece.start)}:end=${number(piece.end)},setpts=PTS-STARTPTS[pv${index}]`);
      if (audio) graph.push(`[basea${baseIndex}]atrim=start=${number(piece.start)}:end=${number(piece.end)},asetpts=PTS-STARTPTS[pa${index}]`);
      baseIndex++; continue;
    }
    const clip = footage.find(clip => clip.placement.id === piece.item.id)!;
    const length = piece.item.length;
    await addInput(clip, length);
    const fit = piece.item.fit === "crop"
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
    graph.push(`[${inputIndex}:V:0]trim=duration=${number(length)},setpts=PTS-STARTPTS,${fit},setsar=1,fps=${number(fps)},format=yuv420p[pv${index}]`);
    if (audio) graph.push(clip.hasAudio && piece.item.audio === "clip"
      ? `[${inputIndex}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${normalizeAudio ? "loudnorm=I=-16:TP=-1.5:LRA=11," : ""}volume=${number(volume)},apad,atrim=duration=${number(length)}[pa${index}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${number(length)}[pa${index}]`);
    inputIndex++;
  }
  graph.push(`${pieces.map((_, i) => `[pv${i}]${audio ? `[pa${i}]` : ""}`).join("")}concat=n=${pieces.length}:v=1:a=${audio ? 1 : 0}[footagevideo]${audio ? "[footageaudio]" : ""}`);
  return timeline.duration;
}
