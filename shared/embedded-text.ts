import { z } from 'zod';

export const embeddedTextRegionSchema = z.object({
  x: z.number().finite().min(0).max(.98), y: z.number().finite().min(0).max(.98),
  width: z.number().finite().min(.02).max(1), height: z.number().finite().min(.02).max(.35),
}).strict().refine(region => region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001,
  'Caption areas must fit inside the original picture.');
export const embeddedTextRegionsSchema = z.array(embeddedTextRegionSchema).max(4)
  .refine(regions => regions.reduce((sum, region) => sum + region.width * region.height, 0) <= .35,
    'Keep caption areas within 35% of the picture.')
  .refine(regions => regions.every((a, i) => regions.slice(i + 1).every(b =>
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)),
    'Caption areas must not overlap.');
export type EmbeddedTextRegion = z.infer<typeof embeddedTextRegionSchema>;
export const embeddedTextShape = {
  preserveEmbeddedText: z.boolean().optional().describe('Keep fixed captions already burned into the source readable when mirror is true. Preserves their original pixels; the background inside each area is also corrected. Cannot reliably preserve an entire app screen or moving text. Review a rendered preview.'),
  embeddedTextRegions: embeddedTextRegionsSchema.optional().describe('Optional fixed caption rectangles in normalized ORIGINAL display coordinates (0–1). Empty or omitted uses local OCR detection. Up to four non-overlapping areas, at most 35% of the picture. No effect unless mirror and preserveEmbeddedText are true.'),
};
export const embeddedTextInstructions = 'preserveEmbeddedText boolean keeps existing burned-in fixed captions readable during horizontal flip. Only takes effect with mirror:true; enable mirror only when flipping is requested. It preserves original lettering by counter-flipping each caption area, including its background; edges may be visible. It does not erase or rewrite captions. embeddedTextRegions is an optional complete list of up to 4 non-overlapping {x,y,width,height} rectangles in normalized original-picture coordinates, totaling at most 35% of the picture (height <=0.35). [] uses automatic local OCR. Preserve existing regions unless asked to replace/reset them; never invent coordinates without explicit user positions. Automatic detection runs later during preview/export, so proposing this setting does not need video analysis now. Detection can fail: a rendered preview is needed to inspect the result. Moving/angled text is not supported. Do not promise to preserve an entire app screen or every label in a screen recording; this corrects limited fixed areas, not screen layouts. This is independent of newly generated captions, custom titles, and caption styling.';
