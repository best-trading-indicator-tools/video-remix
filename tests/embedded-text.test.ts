import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, DEFAULT_AUTO_OPTIONS, type EditPlan } from '../shared/types.js';
import { embeddedTextRegionsSchema } from '../shared/embedded-text.js';
import { playbackSettings } from '../shared/playback.js';
import { autoOptionsSchema, normalizedSettings } from '../server/schema.js';
import { fixedCaptionRegions } from '../server/embedded-text.js';
import { autoPicturePreview } from '../shared/preview-settings.js';
import { sourcePromptProposal } from '../server/source-prompt-routing.js';
import { proposePromptEdit } from '../server/prompt-edit.js';
import { applyEditPlanChanges } from '../server/edit-plan.js';
import { changesBetweenPlans } from '../server/prompt-routes.js';
import { suggestManualBatch } from '../shared/manual-batch.js';
import { suggestAutoBatch } from '../shared/auto-batch.js';

const regions = [{ x: .2, y: .7, width: .6, height: .15 }];
const patch = { mirror: true, preserveEmbeddedText: true, embeddedTextRegions: regions };
test('regions validate in every mode, copy independently and reject overlap, oversized and out-of-bounds areas', () => {
  const auto = autoOptionsSchema.parse({ ...DEFAULT_AUTO_OPTIONS, ...patch });
  assert.deepEqual(autoPicturePreview(auto).embeddedTextRegions, regions);
  const copied = playbackSettings(normalizedSettings(patch)); copied.embeddedTextRegions[0]!.x = .1;
  assert.equal(regions[0]!.x, .2);
  for (const embeddedTextRegions of [[{ x: .9, y: .7, width: .2, height: .15 }], [...regions, ...regions], [{ ...regions[0], height: .5 }], [{ x: 0, y: 0, width: 1, height: .3 }, { x: 0, y: .5, width: 1, height: .3 }]]) {
    assert.throws(() => normalizedSettings({ ...patch, embeddedTextRegions }));
    assert.throws(() => autoOptionsSchema.parse({ ...auto, embeddedTextRegions }));
  }
  assert.deepEqual(embeddedTextRegionsSchema.parse([]), []);
  const fixed = fixedCaptionRegions(Array.from({ length: 12 }, (_, i) => [{ x: .25 - (i % 2) * .05, y: .7, width: .5 + (i % 2) * .1, height: .07 }]));
  assert.equal(fixed.length, 1); assert.ok(fixed[0]!.x < .2 && fixed[0]!.width > .6);
  assert.deepEqual(fixedCaptionRegions(Array.from({ length: 12 }, (_, i) => [{ x: i * .06, y: .7, width: .2, height: .07 }])), [], 'Moving text is not a fixed caption');
  assert.deepEqual(fixedCaptionRegions([[regions[0]!], []]), [], 'One observation is not enough');
});

test('AI proposals apply readable-caption settings, show summaries and current areas, and retain them across workspace switches and saved edits', async t => {
  process.env.DEEPSEEK_API_KEY = 'fixture-readable-text';
  let reply: unknown[] = [], context: any, instructions = '';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); context = JSON.parse(body.messages[1].content); instructions = body.messages[0].content;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply.shift()) } }] });
  });
  const source = { duration: 10, width: 640, height: 360, hasAudio: true }, signal = new AbortController().signal;
  const request = { source, signal, prompt: 'Flip the video and keep its existing text readable', assets: { videos: [], attachments: [] } };
  try {
    for (const draft of [{ options: { ...DEFAULT_AUTO_OPTIONS, embeddedTextRegions: regions, captions: 'keep' as const }, variants: 1 }, { settings: { ...DEFAULT_SETTINGS, embeddedTextRegions: regions, brightness: .1 } }]) {
      reply = [{ patch: { mirror: true, preserveEmbeddedText: true } }];
      const result = await sourcePromptProposal(request, draft), settings = 'settings' in result ? result.settings : result.options;
      assert.equal(settings.preserveEmbeddedText, true); assert.equal(settings.mirror, true); assert.deepEqual(settings.embeddedTextRegions, regions);
      assert.deepEqual(context.currentSettings.embeddedTextRegions, regions); assert.match(instructions, /never invent coordinates/);
      assert.match(instructions, /Do not promise to preserve an entire app screen/);
      assert.match(result.summary.join(' '), /Keep embedded captions readable/);
      reply = [{ patch: { embeddedTextRegions: [] } }];
      const reset = await sourcePromptProposal({ ...request, prompt: 'Use automatic caption areas' }, draft);
      assert.match(reset.summary.join(' '), /automatic detection/);
      reply = [{ patch: { embeddedTextRegions: [{ x: 2, y: 0, width: .2, height: .1 }] } }];
      await assert.rejects(sourcePromptProposal(request, draft));
    }
    reply = [{ patch: {}, switchTo: 'manual' }, { patch: { brightness: .2 } }];
    const manual = await sourcePromptProposal(request, { options: { ...DEFAULT_AUTO_OPTIONS, ...patch }, variants: 1 });
    assert.ok('manual' in manual); assert.deepEqual(manual.manual?.embeddedTextRegions, regions); assert.equal(manual.manual?.preserveEmbeddedText, true);
    reply = [{ patch: {}, switchTo: 'auto' }, { patch: { durationMode: 'full' } }];
    const auto = await sourcePromptProposal(request, { settings: { ...DEFAULT_SETTINGS, ...patch } });
    assert.ok('auto' in auto); assert.deepEqual(auto.auto?.options.embeddedTextRegions, regions); assert.equal(auto.auto?.options.preserveEmbeddedText, true);
    const plan: EditPlan = { version: 1, revision: 1, sourceId: randomUUID(), sourceDuration: 10, outputDuration: 10,
      settings: { ...DEFAULT_SETTINGS, ...patch }, cuts: [{ start: 0, end: 10 }], captions: [], visuals: [], media: [], narration: false, createdAt: new Date().toISOString() };
    reply = [{ operations: [{ op: 'playback', embeddedTextRegions: [], preserveEmbeddedText: false }] }];
    const proposal = await proposePromptEdit({ plan, signal, prompt: 'Turn off caption protection and reset its areas' });
    assert.deepEqual(context.savedVideoContext.embeddedTextRegions, regions); assert.equal(context.savedVideoContext.preserveEmbeddedText, true);
    const next = applyEditPlanChanges(plan, proposal.changes);
    assert.deepEqual(next.settings.embeddedTextRegions, []); assert.equal(next.settings.preserveEmbeddedText, false); assert.equal(next.settings.mirror, true);
    assert.deepEqual(changesBetweenPlans(plan, next).framing, { preserveEmbeddedText: false, embeddedTextRegions: [] });
    assert.match(proposal.summary.join(' '), /automatic detection/);
    assert.deepEqual(plan.settings.embeddedTextRegions, regions);
  } finally { process.env.DEEPSEEK_API_KEY = ''; }
});

test('Quick and Manual batch proposals preserve unchecked videos and each target’s caption areas', async () => {
  const targets = [0, 1, 2].map(i => ({ id: String(i), name: `Video ${i}`, settings: { ...DEFAULT_SETTINGS, mirror: true, embeddedTextRegions: i ? [] : regions, brightness: i / 10 } }));
  const signal = new AbortController().signal;
  const manual = await suggestManualBatch(targets.slice(0, 2), 'Keep embedded text readable', signal,
    async target => ({ settings: { ...target.settings, preserveEmbeddedText: true }, summary: ['Keep embedded captions readable'] }));
  assert.deepEqual(manual.changes.map(item => item.id), ['0', '1']);
  assert.deepEqual(manual.changes.map(item => item.proposal.settings.embeddedTextRegions), [regions, []]);
  assert.equal(manual.changes[1]!.proposal.settings.brightness, .1);
  const auto = await suggestAutoBatch(targets.slice(0, 2).map(target => ({ id: target.id, name: target.name, draft: { options: { ...DEFAULT_AUTO_OPTIONS, embeddedTextRegions: target.settings.embeddedTextRegions }, variants: 1 } })), 'Keep embedded text readable', signal,
    async target => ({ ...target.draft, options: { ...target.draft.options, preserveEmbeddedText: true }, summary: ['Keep embedded captions readable'] }));
  assert.deepEqual(auto.changes.map(item => item.proposal.options.embeddedTextRegions), [regions, []]);
  assert.equal(targets[2]!.settings.preserveEmbeddedText, undefined);
});
