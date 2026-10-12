import { z } from 'zod';
import { CAPTION_FONT_SIZE_MIN, CAPTION_FONT_SIZE_MAX, captionStyleSchema, captionStyleDescription } from './caption-style.js';
import { TITLE_DESIGNS, newTextOverlay, titleOverlay, textOverlaySchema, textOverlaysSchema, type TextOverlay } from './text-overlays.js';

export const titleDesignSchema = z.enum(['bold', 'editorial', 'label', 'announcement']);
const fields = { text: textOverlaySchema.shape.text.optional(), start: textOverlaySchema.shape.start.optional(), end: textOverlaySchema.shape.end.optional(),
  xPercent: textOverlaySchema.shape.xPercent.optional(), widthPercent: textOverlaySchema.shape.widthPercent.optional(),
  style: captionStyleSchema.partial().strict().optional(), design: titleDesignSchema.optional() };
export const textEditsSchema = z.array(z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), ...fields, text: textOverlaySchema.shape.text.refine(text => !!text.trim(), 'Supply the title words') }).strict(),
  z.object({ action: z.literal('update'), id: z.uuid().optional(), index: z.number().int().min(0).max(19).optional(), ...fields }).strict().refine(edit => (edit.id !== undefined) !== (edit.index !== undefined), 'Choose a text ID or zero-based index').refine(edit => Object.keys(edit).some(key => !['action', 'id', 'index'].includes(key)), 'Specify a text change'),
  z.object({ action: z.literal('remove'), id: z.union([z.uuid(), z.literal('all')]).optional(), index: z.number().int().min(0).max(19).optional() }).strict().refine(edit => (edit.id !== undefined) !== (edit.index !== undefined), 'Choose a text ID, all, or zero-based index'),
])).max(40);
export type TextEdit = z.infer<typeof textEditsSchema>[number];

/** Sparse operations preserve other text objects and their unrequested styling. */
export function applyTextEdits(current: TextOverlay[] | undefined, edits: TextEdit[], createId: () => string = () => crypto.randomUUID()) {
  let items = structuredClone(current ?? []);
  for (const edit of textEditsSchema.parse(edits)) {
    const target = edit.action !== 'add' ? edit.id ?? items[edit.index!]?.id : undefined;
    if (edit.action === 'remove') {
      if (target !== 'all' && !items.some(item => item.id === target)) throw new Error('The requested text object is unavailable. Refresh the draft.');
      items = target === 'all' ? [] : items.filter(item => item.id !== target);
      continue;
    }
    const base = edit.action === 'add' ? newTextOverlay(createId(), edit.start ?? 0, edit.end ?? (edit.start ?? 0) + 3) : items.find(item => item.id === target);
    if (!base) throw new Error('The requested text object is unavailable. Refresh the draft.');
    const { action: _action, design, style, ...rest } = edit;
    const { index: _index, ...patch } = rest as typeof rest & { index?: number };
    const designed = design ? titleOverlay(base.id, design, base.text, base.start, base.end) : base;
    const next = { ...base, ...patch, style: { ...designed.style, ...style, wordHighlight: false } };
    items = edit.action === 'add' ? [...items, next] : items.map(item => item.id === base.id ? next : item);
  }
  return textOverlaysSchema.parse(items);
}

export function hasUngroundedTextEdits(edits: TextEdit[] = [], current: TextOverlay[] = [], prompt: string) {
  const normalize = (text: string) => text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  return edits.some(edit => edit.action !== 'remove' && edit.text?.trim() &&
    !(edit.action === 'update' && (edit.id ? current.find(item => item.id === edit.id) : current[edit.index!])?.text === edit.text) && !normalize(prompt).includes(normalize(edit.text)));
}
export function textEditsSummary(before: TextOverlay[] = [], after: TextOverlay[] = []) {
  const summary: string[] = [];
  for (const item of after) if (JSON.stringify(item) !== JSON.stringify(before.find(saved => saved.id === item.id)))
    summary.push(`Text “${item.text}”: ${item.start}–${item.end}s, ${item.widthPercent}% wide, ${item.xPercent}% across. ${captionStyleDescription(item.style).replace('Caption look:', 'Text look:')}`);
  const removed = before.filter(item => !after.some(next => next.id === item.id)).length;
  if (removed) summary.push(`Remove ${removed} text object${removed === 1 ? '' : 's'}.`);
  return summary;
}

export const textEditInstructions = `Independent titles/text use textEdits, an ordered list of sparse operations; never replace unrelated text or switch modes for text.
Add: {action:"add",text:"exact words supplied by user",design:"bold",start:0,end:3}. design is optional: ${TITLE_DESIGNS.map(item => `${item.id} = ${item.name}`).join('; ')}. Designs use the same font, position, colors and animation as the UI. Omitted start/end default to 0–3 seconds.
Update: {action:"update",id:"existing text object ID",style:{fontSize:30,animation:"pop"}}. Remove: {action:"remove",id:"existing ID"} or id:"all". Use current textOverlays IDs; never invent IDs. Update/remove may instead use index (zero-based, 0 is the first text) without id, useful for the same relative text object across bulk videos. Add creates an ID automatically.
Add/update also accept text (up to 500 characters), start/end (output seconds, minimum duration 0.04s), xPercent 5–95, widthPercent 10–90, design and sparse style. style uses captionStyle fields including fontSize ${CAPTION_FONT_SIZE_MIN}–${CAPTION_FONT_SIZE_MAX}, bottomPercent 5–80 and animation none/fade/pop/slide/typewriter/words with animationDuration 0.1–1. Resize independent text with style.fontSize and optionally widthPercent, never captionStyle. Relative size requests adjust the current size within bounds. Applying a design resets the text's appearance to that design; style overrides it. Timings remain fixed when cuts change. New/replacement words must be supplied literally by the user; preserve current words for styling requests. Max 20 text objects. These operations work in Quick/Auto, Manual and saved results, including batch edits.`;
