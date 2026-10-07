import type { CaptionStyle } from "./caption-style.js";

/** Similar-looking Cyrillic letters, not a translation or pronunciation change. */
const LOOKALIKES: Record<string, string> = {
  A: "А", B: "В", C: "С", E: "Е", H: "Н", I: "І", J: "Ј", K: "К", M: "М", O: "О", P: "Р", S: "Ѕ", T: "Т", X: "Х", Y: "У",
  a: "а", c: "с", e: "е", i: "і", j: "ј", o: "о", p: "р", s: "ѕ", x: "х", y: "у",
};
export const cyrillicLookalikes = (text: string) => text.replace(/[ABCEHIJKMOPSTXYaceijopsxy]/gu, letter => LOOKALIKES[letter]!);
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Keep original caption text for editing and timing; use this only for display. */
export function captionDisplayText(text: string, style?: CaptionStyle): string {
  const shown = style?.uppercase ? text.toUpperCase() : text;
  if (!style?.cyrillicMode || style.cyrillicMode === "off") return shown;
  if (style.cyrillicMode === "all") return cyrillicLookalikes(shown);
  const terms = [...new Set((style.cyrillicWords ?? []).map(word => (style.uppercase ? word.toUpperCase() : word).trim()).filter(Boolean))];
  if (!terms.length) return shown;
  // Literal, whole words/phrases. Unicode boundaries protect words in every script;
  // flexible whitespace lets a phrase match across a caption's line break.
  const pattern = terms.sort((a, b) => b.length - a.length).map(term => term.split(/\s+/u).map(escapePattern).join("\\s+")).join("|");
  return shown.replace(new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(?:${pattern})(?![\\p{L}\\p{N}\\p{M}_])`, "giu"), cyrillicLookalikes);
}
