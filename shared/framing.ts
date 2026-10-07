import type { EditPlan, QualityIssue } from "./types.js";
import { resolveCaptionStyle } from "./caption-style.js";
import { captionDisplayText } from "./caption-text.js";

import { wrapEditorialText } from "./text-wrap.js";
export { wrapEditorialText } from "./text-wrap.js";
import { bandTextAppearance, bandTextLayout } from "./black-bands.js";

// Estimates for editor guidance; font shaping and platform overlays vary by device.
export function textLayoutIssues(plan: Pick<EditPlan, "settings" | "captions">, outputAspect?: number): QualityIssue[] {
  const { settings, captions } = plan;
  const aspect = outputAspect && Number.isFinite(outputAspect) && outputAspect > 0 ? outputAspect :
    settings.aspect === "original" ? 9 / 16 : Number(settings.aspect.split(":")[0]) / Number(settings.aspect.split(":")[1]);
  const bands = settings.blackBands?.enabled ? settings.blackBands : undefined;
  const contentTop = (bands?.topPercent ?? 0) / 100;
  const contentHeight = 1 - contentTop - (bands?.bottomPercent ?? 0) / 100;
  const shortSide = Math.min(contentHeight, aspect);
  const boxes: { kind: string; top: number; bottom: number; start: number; end: number }[] = [];
  const wrappedLines = (text: string, columns: number) => text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / columns)), 0);
  if (settings.hookText.trim()) {
    const size = shortSide * 0.054;
    const columns = Math.max(8, Math.floor(aspect * 0.86 / (size * 0.64)));
    boxes.push({ kind: "hook", top: contentTop + contentHeight * 0.08 - size * 0.45, bottom: contentTop + contentHeight * 0.08 + size * (wrapEditorialText(settings.hookText, columns).split("\n").length * 1.25 + 0.45), start: 0, end: settings.hookDuration });
  }
  for (const callout of settings.callouts || []) {
    const size = shortSide * 0.047;
    const columns = Math.max(8, Math.floor(aspect * 0.84 / (size * 0.64)));
    boxes.push({ kind: "callout", top: contentTop + contentHeight * 0.24 - size * 0.45, bottom: contentTop + contentHeight * 0.24 + size * (wrapEditorialText(callout.text, columns).split("\n").length * 1.25 + 0.45), start: callout.start, end: callout.end });
  }
  if (bands) for (const [side, bandHeight, bandTop, kind] of [
    ["top", contentTop, 0, "top band text"],
    ["bottom", bands.bottomPercent / 100, 1 - bands.bottomPercent / 100, "bottom band text"],
  ] as const) {
    const appearance = bandTextAppearance(bands, side);
    if (!appearance.text.trim()) continue;
    const layout = bandTextLayout(appearance.text, aspect * 1000, 1000, bandHeight * 1000, appearance.fontPercent);
    const textHeight = layout.text.split("\n").length * layout.fontSize * 1.25 / 1000;
    boxes.push({ kind, top: bandTop + (bandHeight - textHeight) / 2, bottom: bandTop + (bandHeight + textHeight) / 2, start: 0, end: Infinity });
  }
  const style = resolveCaptionStyle(settings.captionStyle);
  const captionSize = style.fontSize / 288;
  const captionBottom = 1 - style.bottomPercent / 100;
  const letterWidth = { classic: 0.55, "tiktok-sans": 0.55, poppins: 0.6, anton: 0.48, serif: 0.57 }[style.fontFamily] * (style.bold ? 1.04 : 1) * (style.uppercase ? 1.1 : 1);
  const captionColumns = Math.max(8, Math.floor(aspect * 0.9 / (captionSize * letterWidth + style.letterSpacing / 288)));
  const padding = ((style.background === "box" ? 3 : style.outlineWidth) + style.shadow) / 288;
  for (const caption of captions) boxes.push({ kind: "caption", top: captionBottom - captionSize * wrappedLines(captionDisplayText(caption.text, style), captionColumns) * 1.2 - padding, bottom: captionBottom + padding, start: caption.start, end: caption.end });
  const issues: QualityIssue[] = [];
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index]!;
    if (box.top < 0 || box.bottom > 1) issues.push({ code: "text-bounds", message: `The ${box.kind} may extend beyond the picture. Reduce its size or move it.`, start: box.start, end: box.end });
    for (const other of boxes.slice(0, index)) {
      if (box.kind === "caption" && other.kind === "caption") continue;
      const start = Math.max(box.start, other.start), end = Math.min(box.end, other.end);
      if (end > start && Math.min(box.bottom, other.bottom) > Math.max(box.top, other.top))
        issues.push({ code: "text-collision", message: `The ${box.kind} may overlap the ${other.kind}. Check the preview or move the captions.`, start, end });
    }
    if (issues.length >= 20) break;
  }
  return issues.slice(0, 20);
}
