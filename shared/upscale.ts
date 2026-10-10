import { z } from 'zod';

export const upscaleSchema = z.enum(['off', '1080', '1440', '2160']);
export type Upscale = z.infer<typeof upscaleSchema>;
export const UPSCALE_LABELS: Record<Upscale, string> = {
  off: 'Off', '1080': '1080p · Full HD', '1440': '1440p · QHD', '2160': '2160p · 4K',
};
export function upscaleSummary(value: Upscale): string {
  return value === 'off' ? 'Turn off video upscaling.'
    : `Upscale to ${UPSCALE_LABELS[value]} with free local Real-ESRGAN AI; keep larger pictures at their native size.`;
}
export const upscalePromptInstructions = 'upscale off/1080/1440/2160 is the free local Real-ESRGAN AI video upscaler. Use 2160 for 4K, 1440 for QHD and 1080 for Full HD; for an unspecified upscale request use 1080. It reconstructs the main footage with Real-ESRGAN before added captions and overlays. It sets a minimum short edge in pixels after framing, overrides the normal resolution setting while enabled, preserves aspect ratio, and never shrinks a larger native picture. It does not change cuts, captions, audio or FPS. Use off to disable it. It estimates detail rather than recovering a guaranteed original. It requires the locally installed model, and is slower than ordinary resizing.';
