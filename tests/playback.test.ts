import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, DEFAULT_AUTO_OPTIONS, type EditPlan } from '../shared/types.js';
import { autoOptionsSchema, normalizedSettings } from '../server/schema.js';
import { applyEditPlanChanges } from '../server/edit-plan.js';
import { changesBetweenPlans } from '../server/prompt-routes.js';
import { autoPicturePreview } from '../shared/preview-settings.js';
import { transcriptAtSpeed } from '../shared/playback.js';
import { sourcePromptProposal } from '../server/source-prompt-routing.js';
import { proposePromptEdit } from '../server/prompt-edit.js';
import { suggestManualBatch } from '../shared/manual-batch.js';
import { suggestAutoBatch } from '../shared/auto-batch.js';

function savedPlan(): EditPlan {
  return { version: 1, revision: 1, sourceId: randomUUID(), sourceDuration: 20, outputDuration: 10, createdAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS, hookText: 'Keep title', hookDuration: 3, callouts: [{ text: 'Keep callout', start: 4, end: 6 }] },
    cuts: [{ start: 2, end: 12, focalPoint: { x: .2, y: .5 } }], captions: [{ id: 'c', text: 'Corrected caption', start: 4, end: 6 }],
    captionWords: [{ word: 'Corrected', start: 4, end: 5 }],
    visuals: [{ id: 'v', mediaId: 'm', start: 4, end: 5, sourceStart: 1, enabled: true, locked: true }],
    media: [{ id: 'm', name: 'Saved shot', duration: 2, kind: 'broll' }], narration: false };
}

test('Auto and Manual accept independent playback fields, preview them, and reject invalid values', () => {
  for (const patch of [{ speed: .5 }, { speed: 2, mirror: true }, { mirror: false }]) {
    const auto = autoOptionsSchema.parse({ ...DEFAULT_AUTO_OPTIONS, ...patch });
    const manual = normalizedSettings(patch), preview = autoPicturePreview(auto);
    assert.equal(preview.speed, manual.speed); assert.equal(preview.mirror, manual.mirror);
  }
  for (const patch of [{ speed: 0 }, { speed: 2.01 }, { speed: '1.5' }, { speed: NaN }, { mirror: 'true' }]) {
    assert.throws(() => autoOptionsSchema.parse({ ...DEFAULT_AUTO_OPTIONS, ...patch }));
    assert.throws(() => normalizedSettings(patch));
  }
  const transcript = transcriptAtSpeed({ duration: 10, language: 'en', segments: [{ start: 4, end: 6, text: 'hello', words: [{ start: 4, end: 5, word: 'hello' }] }] }, 2);
  assert.equal(transcript.duration, 5); assert.equal(transcript.segments[0]!.words[0]!.start, 2);
});

test('saved speed edits retime corrected speech and locked shots, compose through prompts, and restore cleanly', () => {
  for (const narration of [false, true]) {
    const plan = { ...savedPlan(), narration }, original = structuredClone(plan);
    const faster = applyEditPlanChanges(plan, { revision: 1, framing: { speed: 2, mirror: true } });
    assert.equal(faster.outputDuration, 5); assert.deepEqual(faster.cuts, plan.cuts);
    assert.deepEqual(faster.captions[0], { ...plan.captions[0], start: 2, end: 3 });
    assert.equal(faster.captionWords?.[0]?.start, 2); assert.equal(faster.settings.callouts?.[0]?.start, 2);
    assert.deepEqual(faster.visuals[0], { ...plan.visuals[0], start: 2, end: 2.5, playbackSpeed: 2 });
    assert.equal(faster.settings.hookDuration, 1.5);
    const patch = changesBetweenPlans(plan, faster, undefined, true);
    assert.equal(patch.visuals, undefined, 'Automatic retiming must not block a B-roll refresh');
    assert.equal(patch.captions, undefined); assert.deepEqual(patch.framing, { speed: 2, mirror: true });
    assert.deepEqual(applyEditPlanChanges(plan, patch).captions, faster.captions);
    const slow = applyEditPlanChanges(faster, { revision: 2, framing: { speed: .5 } });
    assert.equal(slow.outputDuration, 20); assert.equal(slow.visuals[0]!.playbackSpeed, .5);
    const restored = applyEditPlanChanges(slow, { revision: 3, framing: { speed: 1, mirror: false } });
    assert.deepEqual(restored.captions, plan.captions); assert.equal(restored.outputDuration, plan.outputDuration);
    assert.deepEqual(plan, original);
  }
  const plan = savedPlan();
  const cut = applyEditPlanChanges(plan, { revision: 1, cuts: [{ start: 4, end: 12 }], framing: { speed: 2 } });
  assert.equal(cut.outputDuration, 4); assert.equal(cut.captions[0]?.start, 1);
  for (const framing of [{ speed: 0 }, { speed: 4 }, { mirror: 'yes' }]) assert.throws(() => applyEditPlanChanges(plan, { revision: 1, framing } as never));
});

test('playback prompts work in every mode, preserve unrelated settings, and carry through workspace switches', async t => {
  process.env.DEEPSEEK_API_KEY = 'fixture-playback';
  let replies: unknown[] = [], context: any, instructions = '';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); context = JSON.parse(body.messages[1].content); instructions = body.messages[0].content;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(replies.shift()) } }] });
  });
  const source = { duration: 20, width: 320, height: 180, hasAudio: true }, signal = new AbortController().signal;
  const request = { source, signal, prompt: 'Set speed to 1.25 and flip horizontally', assets: { videos: [], attachments: [] } };
  try {
    for (const draft of [{ options: { ...DEFAULT_AUTO_OPTIONS, speed: .8, mirror: false }, variants: 1 }, { settings: { ...DEFAULT_SETTINGS, speed: .8, brightness: .1 } }]) {
      replies = [{ patch: { speed: 1.25, mirror: true } }];
      const proposal = await sourcePromptProposal(request, draft);
      const settings = 'settings' in proposal ? proposal.settings : proposal.options;
      assert.equal(settings.speed, 1.25); assert.equal(settings.mirror, true);
      assert.match(proposal.summary.join(' '), /1.25/); assert.match(proposal.summary.join(' '), /Flip horizontally/);
      assert.equal(context.currentSettings.speed, .8); assert.match(instructions, /flip horizontally/);
      assert.ok(!('manual' in proposal) && !('auto' in proposal));
    }
    const plan = savedPlan(); replies = [{ operations: [{ op: 'playback', speed: 2, mirror: true }, { op: 'caption', id: 'c', text: 'New correction' }] }];
    const proposal = await proposePromptEdit({ plan, signal, prompt: request.prompt });
    const next = applyEditPlanChanges(plan, proposal.changes);
    assert.equal(next.captions[0]!.start, 2); assert.equal(next.captions[0]!.text, 'New correction');
    assert.equal(context.savedVideoContext.mirror, false); assert.equal(context.savedVideoContext.playbackSpeed, 1);
    replies = [{ patch: {}, switchTo: 'manual' }, { patch: { brightness: .2 } }];
    const manual = await sourcePromptProposal({ ...request, prompt: 'Increase brightness' }, { options: { ...DEFAULT_AUTO_OPTIONS, speed: 1.5, mirror: true }, variants: 1 });
    assert.ok('manual' in manual); assert.equal(manual.manual?.speed, 1.5); assert.equal(manual.manual?.mirror, true);
    replies = [{ patch: {}, switchTo: 'auto' }, { patch: { durationMode: 'excerpt', targetDuration: 10 } }];
    const auto = await sourcePromptProposal({ ...request, prompt: 'Choose a shorter excerpt' }, { settings: { ...DEFAULT_SETTINGS, speed: .7, mirror: true } });
    assert.ok('auto' in auto); assert.equal(auto.auto?.options.speed, .7); assert.equal(auto.auto?.options.mirror, true);
    replies = [{ operations: [{ op: 'playback', speed: 3 }] }];
    await assert.rejects(proposePromptEdit({ plan, signal, prompt: 'Set speed to 3' }));
  } finally { process.env.DEEPSEEK_API_KEY = ''; }
});

test('Manual and Quick bulk prompts use each checked target, skip matching values, and block partial application', async () => {
  const targets = [0, 1, 2].map(i => ({ id: String(i), name: `Video ${i}`, settings: { ...DEFAULT_SETTINGS, speed: i === 0 ? 1.5 : 1, brightness: i / 10 } }));
  const signal = new AbortController().signal;
  const proposal = await suggestManualBatch(targets.slice(0, 2), 'speed 1.5', signal, async target => target.settings.speed === 1.5
    ? { settings: target.settings, summary: [], unchanged: true, clarification: 'Already matches' }
    : { settings: { ...target.settings, speed: 1.5 }, summary: ['Speed 1.5'] });
  assert.deepEqual(proposal.changes.map(change => change.id), ['1']); assert.equal(proposal.changes[0]!.proposal.settings.brightness, .1);
  assert.equal(proposal.clarification, undefined); assert.equal(targets[2]!.settings.speed, 1);
  const blocked = await suggestManualBatch(targets, 'flip', signal, async target => ({ settings: { ...target.settings, mirror: true }, summary: ['Flip'], ...(target.id === '1' ? { clarification: 'Choose an edit' } : {}) }));
  assert.equal(blocked.changes.length, 0); assert.ok(blocked.clarification);
  const auto = await suggestAutoBatch(targets.slice(0, 2).map(target => ({ id: target.id, name: target.name, draft: { options: { ...DEFAULT_AUTO_OPTIONS, speed: target.settings.speed }, variants: 1 } })), 'flip', signal,
    async target => ({ ...target.draft, options: { ...target.draft.options, mirror: true }, summary: ['Flip'] }));
  assert.deepEqual(auto.changes.map(change => change.proposal.options.speed), [1.5, 1]);
});
