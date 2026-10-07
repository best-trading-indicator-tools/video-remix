import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAutoFootage, suggestAutoBatch, type AutoPromptTarget } from '../shared/auto-batch.js';
import { footageForSource, footageTimeline, type OwnFootagePlacement } from '../shared/own-footage.js';
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS } from '../shared/types.js';

const targets: AutoPromptTarget[] = [
  { id: 'one', name: 'First.mp4', draft: { options: { ...DEFAULT_AUTO_OPTIONS, aspect: '1:1', targetDuration: 20 }, variants: 1 } },
  { id: 'two', name: 'Second.mp4', draft: { options: { ...DEFAULT_AUTO_OPTIONS, aspect: '16:9', targetDuration: 90 }, variants: 3 } },
];
const outro: OwnFootagePlacement = { id: 'outro', assetId: 'uploaded', mode: 'insert', appendToEnd: true, at: 0, start: 0, end: 7, audio: 'clip', fit: 'contain' };

test('bulk footage replaces only target placements, binds them for reload/export, and follows each end', () => {
  const current = Object.fromEntries(targets.map(target => [target.id, target.draft]));
  current.unchecked = targets[0]!.draft;
  const before = structuredClone(current), defaults = structuredClone(targets[0]!.draft);
  const updated = applyAutoFootage(current, defaults, ['one', 'two'], [outro]);
  assert.deepEqual(current, before);
  assert.deepEqual(defaults, targets[0]!.draft);
  assert.equal(updated.unchecked, current.unchecked);
  for (const target of targets) {
    const draft = updated[target.id]!;
    assert.equal(draft.options.aspect, target.draft.options.aspect);
    assert.equal(draft.variants, target.draft.variants);
    assert.deepEqual(footageForSource(draft.options, target.id).ownFootage, [outro]);
    assert.deepEqual(footageForSource(draft.options).ownFootage, []);
    const timeline = footageTimeline(draft.options.ownFootage, target.draft.options.targetDuration);
    assert.equal(timeline.inserts[0]!.at, target.draft.options.targetDuration);
    assert.equal(timeline.duration, target.draft.options.targetDuration + 7);
  }
  assert.notEqual(updated.one!.options.ownFootage, updated.two!.options.ownFootage);
  const removed = applyAutoFootage(updated, defaults, ['two'], []);
  assert.deepEqual(removed.two!.options.ownFootage, []);
  assert.deepEqual(removed.one!.options.ownFootage, [outro]);
  const newTarget = applyAutoFootage(current, defaults, ['new'], [outro]);
  assert.equal(newTarget.new!.options.ownFootageSourceId, 'new');
});

test('bulk prompts use each target draft, preserve source order and cap API concurrency at two', async () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ ...targets[i % 2]!, id: String(i) }));
  const before = structuredClone(many), progress: number[] = [];
  let active = 0, maximum = 0;
  const result = await suggestAutoBatch(many, 'Add an ending clip', new AbortController().signal, async (target, prompt) => {
    assert.equal(prompt, 'Add an ending clip');
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, Number(target.id) % 2 ? 1 : 5));
    active--;
    return { ...target.draft, options: { ...target.draft.options, ownFootage: [outro] }, summary: ['Append all 7 seconds.'] };
  }, count => progress.push(count));
  assert.equal(maximum, 2);
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.changes.map(change => change.id), many.map(target => target.id));
  assert.deepEqual(result.changes.map(change => change.proposal.options.aspect), many.map(target => target.draft.options.aspect));
  assert.deepEqual(result.reviewGroups.map(group => group.title), many.map(target => target.name));
  assert.deepEqual(many, before);
});

test('already matching targets do not block remaining edits or produce fake changes', async () => {
  const result = await suggestAutoBatch(targets, 'Add captions', new AbortController().signal, async target => target.id === 'one'
    ? { ...target.draft, unchanged: true, summary: [] }
    : { ...target.draft, options: { ...target.draft.options, captions: 'add' }, summary: ['Add captions.'] });
  assert.equal(result.clarification, undefined);
  assert.deepEqual(result.changes.map(change => change.id), ['two']);
  assert.match(result.reviewGroups[0]!.summary[0]!, /Already matches/);
  const noChange = await suggestAutoBatch(targets, 'Keep settings', new AbortController().signal, async target => ({ ...target.draft, unchanged: true, summary: [] }));
  assert.equal(noChange.changes.length, 0); assert.match(noChange.clarification!, /already match/);
});

test('clarification and mixed-workspace proposals never permit a partial batch apply', async () => {
  const blocked = await suggestAutoBatch(targets, 'Use my clip', new AbortController().signal, async target => ({ ...target.draft,
    summary: ['Add clip.'], ...(target.id === 'two' ? { clarification: 'Which uploaded clip?' } : {}) }));
  assert.deepEqual(blocked.changes, []); assert.match(blocked.clarification!, /Second.mp4: Which uploaded clip/);
  const mixed = await suggestAutoBatch(targets, 'Edit', new AbortController().signal, async target => ({ ...target.draft,
    summary: ['Edit.'], ...(target.id === 'two' ? { manual: DEFAULT_SETTINGS } : {}) }));
  assert.deepEqual(mixed.changes, []); assert.match(mixed.clarification!, /different workspaces/);
  const manual = await suggestAutoBatch(targets, 'Make warmer', new AbortController().signal, async target => ({ ...target.draft,
    summary: ['Continue in Manual.'], manual: { ...DEFAULT_SETTINGS, temperature: .1 } }));
  assert.equal(manual.changes.length, 2); assert.equal(manual.clarification, undefined);
});

test('failures identify the video and cancel other in-flight proposals without scheduling more', async () => {
  let called = 0, aborted = false;
  await assert.rejects(suggestAutoBatch([...targets, { ...targets[0]!, id: 'three' }], 'Edit', new AbortController().signal, async (target, _prompt, signal) => {
    called++;
    if (target.id === 'one') {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    }
    throw new Error('Assistant unavailable');
  }), /Second.mp4: Assistant unavailable.*No videos were changed/);
  assert.equal(called, 2); assert.equal(aborted, true);
});

test('cancelled and empty selections cannot produce applicable proposals', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(suggestAutoBatch(targets, 'Edit', controller.signal, async () => assert.fail('No request after cancellation')), /abort/i);
  await assert.rejects(suggestAutoBatch([], 'Edit', new AbortController().signal, async () => assert.fail('No empty request')), /Check videos/);
  const pending = new AbortController(); let count = 0;
  await assert.rejects(suggestAutoBatch([...targets, ...targets], 'Edit', pending.signal, async target => {
    count++; pending.abort(); return { ...target.draft, summary: ['Edit.'] };
  }), /abort/i);
  assert.equal(count, 1);
});
