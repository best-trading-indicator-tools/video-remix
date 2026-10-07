import { z } from "zod";
import type { CaptionCue } from "./types.js";

export const ownFootageSchema = z.array(z.object({
  id: z.uuid(), assetId: z.uuid(), mode: z.enum(["insert", "cover"]),
  appendToEnd: z.boolean().optional(),
  at: z.number().finite().min(0).max(172800),
  start: z.number().finite().min(0).max(86400), end: z.number().finite().min(0).max(86400),
  audio: z.enum(["clip", "mute"]), fit: z.enum(["contain", "crop"]),
}).strict().refine(item => item.appendToEnd || item.end - item.start >= 0.1, "Select at least 0.1 seconds of your footage")
  .refine(item => !item.appendToEnd || item.mode === "insert", "Clips added at the end must use Insert mode"))
  .max(20).refine(items => new Set(items.map(item => item.id)).size === items.length, "Each placement needs its own ID")
  .refine(items => { const covers = items.filter(item => item.mode === "cover").sort((a, b) => a.at - b.at); return covers.every((item, i) => !i || item.at >= covers[i - 1]!.at + covers[i - 1]!.end - covers[i - 1]!.start); }, "Your cover shots cannot overlap. Move one to a different time.");
export type OwnFootagePlacement = z.infer<typeof ownFootageSchema>[number];
export interface OwnFootageAsset { id: string; name: string; duration: number; hasAudio: boolean; url: string; thumbnailUrl?: string }

export function footagePlacementLabel(item: OwnFootagePlacement) {
  const seconds = (n: number) => `${Number(n.toFixed(2))}s`;
  if (item.appendToEnd) return "Outro · whole clip after this video";
  const length = seconds(item.end - item.start);
  if (item.mode === "insert" && item.at === 0) return `Intro · ${length} before this video`;
  return item.mode === "insert" ? `Insert at ${seconds(item.at)} · adds ${length}` : `Cover at ${seconds(item.at)} · ${length}`;
}

/** Resolve the full asset on the server; a saved trim must not shorten an outro. */
export function resolveFootagePlacement(item: OwnFootagePlacement, assetDuration: number): OwnFootagePlacement {
  return item.appendToEnd ? { ...item, mode: "insert", at: 0, start: 0, end: assetDuration } : item;
}

/** Times stay on the edit's clock, before inserted footage lengthens it. */
export function footageTimeline(placements: OwnFootagePlacement[] = [], duration: number, fps = 30) {
  const frame = (time: number) => Math.round(time * fps) / fps;
  // Cut boundaries can fall between output frames (source fps and speed differ).
  // Re-rounding a saved insertion can move it inside its neighboring cut and
  // create a tiny source fragment that makes the next timeline edit invalid.
  const inserts = placements.filter(item => item.mode === "insert").map(item => ({ ...item,
    at: item.appendToEnd ? duration : Math.min(duration, item.at), length: Math.max(1 / fps, frame(item.end - item.start)),
  })).sort((a, b) => a.at - b.at);
  const covers = placements.filter(item => item.mode === "cover" && item.at < duration).map(item => ({ ...item,
    length: Math.min(item.end - item.start, duration - item.at),
  })).filter(item => item.length >= 1 / fps);
  return { inserts, covers, duration: duration + inserts.reduce((sum, item) => sum + item.length, 0) };
}

/** Captions crossing an insertion are split so they disappear during the inserted clip. */
export function captionsAfterInserts(captions: CaptionCue[], placements: OwnFootagePlacement[], duration: number, fps: number): CaptionCue[] {
  const { inserts } = footageTimeline(placements, duration, fps);
  return captions.flatMap(cue => {
    const edges = [...new Set([cue.start, ...inserts.map(item => item.at).filter(at => at > cue.start && at < cue.end), cue.end])];
    return edges.slice(0, -1).map((start, index) => ({ ...cue, id: `${cue.id}-${index}`,
      start: start + inserts.filter(item => item.at <= start).reduce((sum, item) => sum + item.length, 0),
      end: edges[index + 1]! + inserts.filter(item => item.at < edges[index + 1]!).reduce((sum, item) => sum + item.length, 0),
    }));
  });
}
