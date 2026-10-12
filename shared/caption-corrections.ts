import { z } from 'zod';

const plain = z.string().max(100).refine(text => !/[\u0000-\u001f\u007f]|\{\\|<[^>]*>|-->/u.test(text), 'Use plain text on one line');
export const captionCorrectionSchema = z.object({
  find: plain.refine(text => !!text.trim(), 'Enter words to find'),
  replace: plain,
  caseSensitive: z.boolean().default(false),
  wholeWord: z.boolean().default(true),
}).strict();
export const captionCorrectionsSchema = z.array(captionCorrectionSchema).max(50);
export type CaptionCorrection = z.infer<typeof captionCorrectionSchema>;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Literal replacements, in listed order. Never touch timestamps or the source transcript. */
export function correctCaptionText(text: string, rules: CaptionCorrection[] = []) {
  let matches = 0;
  for (const rule of rules) {
    const term = rule.find.trim().split(/\s+/u).map(escape).join('\\s+');
    const pattern = rule.wholeWord ? `(?<![\\p{L}\\p{N}\\p{M}_])(?:${term})(?![\\p{L}\\p{N}\\p{M}_])` : term;
    text = text.replace(new RegExp(pattern, rule.caseSensitive ? 'gu' : 'giu'), () => { matches++; return rule.replace; });
  }
  if (matches) text = text.split('\n').map(line => line.replace(/[ \t]+/gu, ' ').trim()).filter(Boolean).join('\n');
  if (text.length > 500) throw new Error('A corrected caption exceeds 500 characters. Shorten the replacement.');
  return { text, matches };
}

export function correctCaptionCues<T extends { text: string }>(cues: T[], rules: CaptionCorrection[]) {
  let matches = 0, changed = 0;
  const captions = cues.flatMap(cue => {
    const result = correctCaptionText(cue.text, rules);
    matches += result.matches;
    if (result.text !== cue.text) changed++;
    return result.text ? [{ ...cue, text: result.text }] : [];
  });
  return { captions, matches, changed };
}
