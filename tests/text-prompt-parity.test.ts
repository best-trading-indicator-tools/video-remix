import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS, type EditPlan } from '../shared/types.js';
import { TITLE_DESIGNS, titleOverlay } from '../shared/text-overlays.js';
import { applyTextEdits, textEditsSchema } from '../shared/text-edits.js';
import { proposeAutoPrompt } from '../server/auto-prompt.js';
import { proposeManualPrompt } from '../server/manual-prompt.js';
import { sourcePromptProposal } from '../server/source-prompt-routing.js';
import { proposePromptEdit } from '../server/prompt-edit.js';
import { applyEditPlanChanges } from '../server/edit-plan.js';
import { changesBetweenPlans } from '../server/prompt-routes.js';

test('titles, resizing, animations and correction rules compile through every prompt mode', async t => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'fixture-text-prompts';
  let reply: unknown, pending: unknown[] = [], context: any, instructions = '';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); instructions = body.messages[0].content; context = JSON.parse(body.messages[1].content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(pending.length ? pending.shift() : reply) } }] });
  });
  const source = { duration: 30, width: 640, height: 360, hasAudio: true }, signal = new AbortController().signal;
  const old = titleOverlay(randomUUID(), 'editorial', 'Keep these words', 1, 5), other = titleOverlay(randomUUID(), 'label', 'Keep this too', 6, 9);
  const settings = { ...DEFAULT_SETTINGS, textOverlays: [old, other], captionStyle: { fontSize: 19, bottomPercent: 14, color: '#00ff00' } };
  const options = { ...DEFAULT_AUTO_OPTIONS, textOverlays: [old, other] };
  try {
    for (const design of TITLE_DESIGNS) await t.test(`${design.name} is the same design in Quick/Auto and Manual`, async () => {
      reply = { patch: { textEdits: [{ action: 'add', design: design.id, text: 'NEW TITLE', start: 0, end: 3 }] } };
      const automatic = await proposeAutoPrompt({ options, variants: 2, source, signal, prompt: `Add ${design.name} saying NEW TITLE` });
      const manual = await proposeManualPrompt({ settings, source, signal, prompt: `Add ${design.name} saying NEW TITLE` });
      for (const next of [automatic.options, manual.settings]) {
        assert.deepEqual(next.textOverlays?.slice(0, 2), [old, other]);
        assert.deepEqual(next.textOverlays?.[2]?.style, titleOverlay(randomUUID(), design.id, 'NEW TITLE').style);
      }
      assert.equal(automatic.switchTo, undefined); assert.equal(automatic.variants, 2);
      assert.ok(automatic.summary.some(line => line.includes('NEW TITLE')));
      assert.match(instructions, /textEdits.*ordered list/s);
      assert.deepEqual(context.currentSettings.textOverlays, [old, other]);
    });
    await t.test('relative text updates preserve words, timings, other objects and speech-caption style', async () => {
      reply = { patch: { textEdits: [{ action: 'update', id: old.id, style: { fontSize: 32, animation: 'typewriter' }, widthPercent: 85 }] } };
      const result = await proposeManualPrompt({ settings, source, signal, prompt: 'Make the first text larger and typewriter animated' });
      assert.deepEqual(result.settings.textOverlays?.[0], { ...old, widthPercent: 85, style: { ...old.style, fontSize: 32, animation: 'typewriter' } });
      assert.deepEqual(result.settings.textOverlays?.[1], other);
      assert.deepEqual(result.settings.captionStyle, settings.captionStyle);
      assert.deepEqual(settings.textOverlays, [old, other]);
    });
    await t.test('invalid targets/ranges and invented wording never silently change a draft', async () => {
      for (const edit of [{ action: 'update', id: randomUUID(), style: { fontSize: 24 } }, { action: 'update', id: old.id, style: { fontSize: 99 } }, { action: 'add', text: 'hello', design: 'unknown' }]) {
        reply = { patch: { textEdits: [edit] } };
        await assert.rejects(proposeAutoPrompt({ options, variants: 1, source, signal, prompt: 'hello' }));
      }
      reply = { patch: { textEdits: [{ action: 'add', text: 'Invented title', design: 'bold' }], captionStyle: { animation: 'pop' } } };
      const result = await proposeAutoPrompt({ options, variants: 1, source, signal, prompt: 'Make it stylish' });
      assert.ok(result.clarification); assert.deepEqual(result.options, options);
    });
    await t.test('correction rules and text survive both workspace handoffs', async () => {
      const captionCorrections = [{ find: 'acme', replace: 'ACME', wholeWord: true, caseSensitive: false }];
      pending = [{ patch: {}, switchTo: 'manual' }, { patch: { speed: 1.2 } }];
      const manual = await sourcePromptProposal({ source, signal, prompt: 'Speed up to 1.2', assets: { videos: [], attachments: [] } }, { options: { ...options, captionCorrections }, variants: 1 });
      assert.ok('manual' in manual && manual.manual);
      if ('manual' in manual) { assert.deepEqual(manual.manual?.textOverlays, [old, other]); assert.deepEqual(manual.manual?.captionCorrections, captionCorrections); }
      pending = [{ patch: {}, switchTo: 'auto' }, { patch: { durationMode: 'excerpt', targetDuration: 10 } }];
      const automatic = await sourcePromptProposal({ source, signal, prompt: 'Choose a 10 second excerpt', assets: { videos: [], attachments: [] } }, { settings: { ...settings, captionCorrections } });
      assert.ok('auto' in automatic && automatic.auto);
      if ('auto' in automatic) { assert.deepEqual(automatic.auto?.options.textOverlays, [old, other]); assert.deepEqual(automatic.auto?.options.captionCorrections, captionCorrections); }
    });
    await t.test('saved-result bulk corrections, text and animations survive cumulative API diffs and Undo baseline', async () => {
      const plan: EditPlan = { version: 1, revision: 1, sourceId: randomUUID(), sourceDuration: 30, outputDuration: 30, createdAt: new Date().toISOString(),
        settings, cuts: [{ start: 0, end: 30 }], captions: [{ id: 'a', text: 'acme hello', start: 1, end: 2 }, { id: 'b', text: 'acme', start: 3, end: 4 }], visuals: [], media: [], narration: false };
      const original = structuredClone(plan);
      reply = { operations: [
        { op: 'text_overlays', edits: [{ action: 'update', id: old.id, style: { fontSize: 31, animation: 'pop' } }, { action: 'add', text: 'NEW TITLE', design: 'announcement' }] },
        { op: 'caption_corrections', rules: [{ find: 'acme', replace: 'ACME', wholeWord: true, caseSensitive: false }] },
        { op: 'caption_style', animation: 'words', wordHighlight: true }, { op: 'upscale', target: '1080' },
      ] };
      const result = await proposePromptEdit({ plan, signal, prompt: 'Add NEW TITLE, make the first text larger, replace acme with ACME and animate captions' });
      assert.deepEqual(context.savedVideoContext.textOverlays, [old, other]);
      assert.match(instructions, /caption_corrections/); assert.match(instructions, /animationDuration/);
      const next = applyEditPlanChanges(plan, result.changes);
      const changes = changesBetweenPlans(plan, next);
      assert.equal(changes.textOverlays?.length, 3); assert.equal(changes.framing?.upscale, '1080');
      assert.equal(changes.captions?.[0]?.text, 'ACME hello'); assert.equal(changes.captions?.[1]?.text, 'ACME');
      assert.equal(changes.captions?.[0]?.start, 1); assert.equal(changes.captions?.[1]?.end, 4);
      assert.equal(changes.framing?.captionStyle?.animation, 'words');
      reply = { operations: [{ op: 'text_overlays', edits: [{ action: 'remove', id: other.id }] }] };
      const followup = await proposePromptEdit({ plan: next, signal, prompt: 'Remove the second text' });
      const combined = changesBetweenPlans(plan, applyEditPlanChanges(next, followup.changes));
      assert.equal(combined.textOverlays?.length, 2); assert.equal(combined.captions?.[0]?.text, 'ACME hello');
      assert.deepEqual(plan, original);
    });
  } finally { if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = originalKey; }
});

test('text operations support batch-relative targets while rejecting ambiguous or missing targets', () => {
  const title = titleOverlay(randomUUID(), 'bold', 'TITLE');
  const edited = applyTextEdits([title], [{ action: 'update', index: 0, style: { fontSize: 25 } }]);
  assert.equal(edited[0]?.style.fontSize, 25); assert.equal(edited[0]?.id, title.id);
  assert.deepEqual(applyTextEdits(edited, [{ action: 'remove', index: 0 }]), []);
  assert.throws(() => applyTextEdits([], [{ action: 'update', index: 0, style: { fontSize: 25 } }]), /unavailable/);
  assert.equal(textEditsSchema.safeParse([{ action: 'update', id: title.id, index: 0, style: { fontSize: 25 } }]).success, false);
});
