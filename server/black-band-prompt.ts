import type { z } from "zod";
import type { BlackBands, blackBandsPatchSchema } from "../shared/black-bands.js";

export const blackBandPromptInstructions = `Black-band controls: enabled boolean, fit contain/crop, topPercent and bottomPercent each 10–40 (sum at most 70), topText and bottomText up to 200 printable characters, fontPercent 3–10 (legacy shared default). Enable bands when adding text to them. Defaults are top 25%, bottom 15%, font 5.4%, contain. Upper/top band means topText and topStyle; lower/bottom band means bottomText and bottomStyle, not speech captions or opening hooks. Preserve all unrequested text, dimensions and styles.
topStyle and bottomStyle are sparse objects with color (six-digit #RRGGBB), fontPercent (3–10), cyrillic (boolean). Set sizes per band using these styles, including both styles when changing both bands. Small=3.5%, medium=5.4%, large=8%. White=#ffffff. Explicit Cyrillic/lookalike spelling of Latin names uses cyrillic:true on the requested band: keep the literal original text in topText/bottomText; conversion happens only for display. This is not a translation; already-Cyrillic characters are preserved. cyrillic:false restores original spelling. Do not change captionStyle for a band-text request or claim platform moderation outcomes.
For example, "Add BPC157 in cyrillic white font medium size font in upper band" means enabled:true, topText:"BPC157", topStyle:{cyrillic:true,color:"#ffffff",fontPercent:5.4}. It displays ВРС157, white, medium, throughout the upper band. Do not replace the literal BPC157 with converted characters in the saved text. New band text must be supplied literally in the user's request; never invent text.`;

export function hasUngroundedBlackBandText(patch: z.infer<typeof blackBandsPatchSchema>, before: BlackBands | undefined, prompt: string): boolean {
  const normalize = (text: string) => text.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  return (["topText", "bottomText"] as const).some(key => {
    const value = patch[key];
    return !!value?.trim() && value !== before?.[key] && !normalize(prompt).includes(normalize(value));
  });
}
