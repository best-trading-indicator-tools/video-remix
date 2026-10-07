import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, DEFAULT_AUTO_OPTIONS, type AutoOptions } from '../shared/types.js';
import { DEFAULT_BLACK_BANDS } from '../shared/black-bands.js';
import { proposeManualPrompt } from '../server/manual-prompt.js';
import { proposeAutoPrompt } from '../server/auto-prompt.js';
import { sourcePromptProposal } from '../server/source-prompt-routing.js';
import { PromptEditError } from '../server/prompt-edit.js';

const source = { duration: 120, width: 1920, height: 1080, hasAudio: true };
test('source prompts expose supported editing controls and preserve reviewable draft semantics', async t => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-source-prompt';
  let reply: unknown;
  let context: any;
  let replies: unknown[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_input, init) => {
    const request = JSON.parse(String(init?.body)); context = JSON.parse(request.messages[1].content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(replies.length ? replies.shift() : reply) } }] });
  });
  const signal = new AbortController().signal;
  const assets = { videos: [{ id: randomUUID(), name: '/private/uploads/outro.mp4', duration: 7 }],
    attachments: [{ id: randomUUID(), name: 'music.mp3', kind: 'audio' as const }, { id: randomUUID(), name: 'captions.srt', kind: 'subtitle' as const }] };
  const manual = (patch: unknown, settings = DEFAULT_SETTINGS, prompt = 'Add captions, black bands and B-roll') => {
    reply = { patch }; return proposeManualPrompt({ settings, source, signal, prompt, assets });
  };
  const auto = (patch: unknown, options: AutoOptions = DEFAULT_AUTO_OPTIONS, variants = 1, requestedVariants?: number) => {
    reply = { patch, ...(requestedVariants === undefined ? {} : { variants: requestedVariants }) };
    return proposeAutoPrompt({ options, variants, source, signal, prompt: 'Remix with captions, black bands and B-roll', assets });
  };
  try {
    await t.test('Manual combines captions, bands and stock without losing unrelated settings', async () => {
      const settings = { ...DEFAULT_SETTINGS, speed: 1.2, subtitleId: assets.attachments[1]!.id,
        blackBands: { ...DEFAULT_BLACK_BANDS, topText: 'Keep this heading', topPercent: 30 },
        captionStyle: { fontSize: 24, bottomPercent: 15, fontFamily: 'poppins' as const } };
      const before = structuredClone(settings);
      const result = await manual({ automaticCaptions: 'add', blackBands: { enabled: true },
        captionStyle: { color: '#ffee00', wordHighlight: true }, visualSources: ['pexels', 'remotion'], brollCount: 5, brollMaxCoverage: 40 }, settings);
      assert.equal(result.settings.subtitleId, null);
      assert.equal(result.settings.speed, 1.2);
      assert.equal(result.settings.blackBands?.topText, 'Keep this heading');
      assert.equal(result.settings.blackBands?.topPercent, 30);
      assert.equal(result.settings.captionStyle?.fontFamily, 'poppins');
      assert.equal(result.settings.captionStyle?.wordHighlight, true);
      assert.deepEqual(result.settings.visualSources, ['pexels', 'remotion']);
      assert.match(result.summary.join(' '), /Black bands.*Pexels.*Remotion.*5.*40/s);
      assert.deepEqual(settings, before);
    });
    await t.test('uploaded footage and audio use bounded catalog references, with no local paths or IDs sent to the provider', async () => {
      const result = await manual({ audioAttachment: 'audio1', subtitleAttachment: 'subtitle2', brollClips: ['video1'], visualSources: ['library'],
        footage: [{ asset: 'video1', mode: 'insert', appendToEnd: true, at: 0, start: 1, end: 2, audio: 'clip', fit: 'contain' }] });
      assert.equal(result.settings.audioId, assets.attachments[0]!.id);
      assert.equal(result.settings.subtitleId, assets.attachments[1]!.id);
      assert.equal(result.settings.automaticCaptions, 'off');
      assert.equal(result.settings.ownFootage?.[0]?.end, 7);
      assert.equal(result.settings.ownFootage?.[0]?.start, 0);
      assert.equal(result.settings.ownFootage?.[0]?.assetId, assets.videos[0]!.id);
      assert.deepEqual(result.settings.brollIds, [assets.videos[0]!.id]);
      assert.match(result.summary.join(' '), /127 seconds/);
      assert.ok(!JSON.stringify(context).includes('/private/'));
      for (const asset of [...assets.videos, ...assets.attachments]) assert.ok(!JSON.stringify(context).includes(asset.id));
      assert.ok(context.assets.some((item: { name: string }) => item.name === 'outro.mp4'));
    });
    await t.test('missing assets, wrong kinds and out-of-range placements reject the entire proposal', async () => {
      for (const patch of [{ audioAttachment: 'audio9' }, { subtitleAttachment: 'subtitle1' }, { brollClips: ['video2'] },
        { footage: [{ asset: 'video1', mode: 'cover', at: 0, start: 1, end: 9, audio: 'mute', fit: 'crop' }] },
        { automaticCaptions: 'add', subtitleAttachment: 'subtitle2' }])
        await assert.rejects(manual({ brightness: 0.1, ...patch }), (error: unknown) => error instanceof PromptEditError && error.status === 422);
    });
    await t.test('remove all captions clears both generation and the existing SRT', async () => {
      const result = await manual({ automaticCaptions: 'off', subtitleAttachment: null }, { ...DEFAULT_SETTINGS, automaticCaptions: 'auto', subtitleId: assets.attachments[1]!.id });
      assert.equal(result.settings.automaticCaptions, 'off'); assert.equal(result.settings.subtitleId, null);
      assert.doesNotMatch(result.summary.join(' '), /Use automatic captions/);
    });
    await t.test('Auto combines all shared controls with version, pacing, review and sound changes', async () => {
      const options: AutoOptions = { ...DEFAULT_AUTO_OPTIONS, aspect: '16:9', targetDuration: 55, narration: true,
        blackBands: { ...DEFAULT_BLACK_BANDS, topText: 'Saved headline' }, captionStyle: { fontSize: 22, bottomPercent: 18, bold: true } };
      const before = structuredClone(options);
      const result = await auto({ captions: 'add', blackBands: { enabled: true, bottomPercent: 20 }, captionStyle: { color: '#ffee00' },
        visualSources: ['pixabay', 'remotion'], brollCount: 6, brollMaxCoverage: 50, audio: 'podcast',
        pacing: { mode: 'tight', removeFillers: true }, editorialMode: 'check', finishedReview: false }, options, 1, 3);
      assert.equal(result.options.aspect, '16:9'); assert.equal(result.options.targetDuration, 55); assert.equal(result.options.narration, true);
      assert.equal(result.variants, 3); assert.equal(result.options.pacing?.keepPause, options.pacing?.keepPause);
      assert.equal(result.options.captionStyle?.fontSize, 22); assert.equal(result.options.blackBands?.topText, 'Saved headline');
      for (const word of ['Black bands', 'Pixabay', 'Remotion', 'Caption look', 'Pacing', 'Editorial review', 'Finished video review', 'podcast']) assert.ok(result.summary.join(' ').includes(word), word);
      assert.deepEqual(options, before);
    });
    await t.test('sparse Auto proposals do not reset defaults or unrelated choices', async () => {
      const options: AutoOptions = { ...DEFAULT_AUTO_OPTIONS, aspect: '1:1', targetDuration: 75, narration: true };
      const result = await auto({ captions: 'add' }, options, 3);
      assert.deepEqual(result.options, { ...options, captions: 'add' }); assert.equal(result.variants, 3);
      assert.deepEqual(result.summary, ['Captions: add new captions.']);
      assert.ok((await auto({}, options, 3)).clarification);
    });
    await t.test('full video and narration dependencies are explicit and contradictory requests stay unchanged', async () => {
      const options: AutoOptions = { ...DEFAULT_AUTO_OPTIONS, narration: true, versionMode: 'angles' };
      const result = await auto({ durationMode: 'full' }, options, 4);
      assert.equal(result.variants, 1); assert.equal(result.options.narration, false); assert.equal(result.options.versionMode, 'moments');
      assert.match(result.summary.join(' '), /Replacement narration: off/);
      const conflict = await auto({ durationMode: 'full', narration: true }, options, 4, 3);
      assert.ok(conflict.clarification); assert.deepEqual(conflict.options, options); assert.equal(conflict.variants, 4);
      const off = await auto({ audio: 'off' }, { ...DEFAULT_AUTO_OPTIONS, narration: true });
      assert.equal(off.options.narration, false); assert.match(off.summary.join(' '), /Replacement narration: off/);
    });
    await t.test('cross-workspace edits prepare a complete proposal before changing modes', async () => {
      const base = { source, signal, assets };
      const options = { ...DEFAULT_AUTO_OPTIONS, blackBands: { ...DEFAULT_BLACK_BANDS, enabled: true } };
      replies = [{ patch: {}, switchTo: 'manual' }, { patch: { trimStart: 10, trimEnd: 30, speed: 1.25, temperature: 0.1 } }];
      const manual = await sourcePromptProposal({ ...base, prompt: 'Keep 10 to 30 seconds, speed up to 1.25x and make it warmer' }, { options, variants: 2 });
      assert.ok('manual' in manual && manual.manual);
      if ('manual' in manual && manual.manual) {
        assert.equal(manual.manual.trimStart, 10); assert.equal(manual.manual.speed, 1.25);
        assert.equal(manual.manual.blackBands?.enabled, true);
      }
      assert.match(manual.summary[0]!, /Continue in Manual/);
      replies = [{ patch: {}, switchTo: 'auto' }, { patch: { durationMode: 'excerpt', targetDuration: 30, captions: 'auto', audio: 'auto', narration: true } }];
      const automatic = await sourcePromptProposal({ ...base, prompt: 'Choose a 30 second clip with new narration' }, { settings: DEFAULT_SETTINGS });
      assert.ok('auto' in automatic && automatic.auto?.options.narration);
      assert.match(automatic.summary[0]!, /Continue in Auto/);
      replies = [{ patch: {}, switchTo: 'auto' }, { patch: {}, switchTo: 'manual' }];
      const incompatible = await sourcePromptProposal({ ...base, prompt: 'Change exact cuts and automatic selection together' }, { settings: DEFAULT_SETTINGS });
      assert.ok('clarification' in incompatible && incompatible.clarification);
      assert.deepEqual(incompatible.summary, []);
      assert.equal(replies.length, 0, 'routing stops after one workspace handoff');
    });
    await t.test('invalid band geometry and unknown controls are rejected; unsupplied written text requires clarification', async () => {
      for (const propose of [manual, auto]) {
        await assert.rejects(propose({ blackBands: { enabled: true, topPercent: 40, bottomPercent: 40 } }), (error: unknown) => error instanceof PromptEditError && error.status === 422);
        await assert.rejects(propose({ visualSources: ['unknown'] }), (error: unknown) => error instanceof PromptEditError && error.status === 502);
        const invented = await propose({ blackBands: { enabled: true, topText: 'An invented claim' } });
        assert.ok(invented.clarification); assert.deepEqual(invented.summary, []);
      }
      const exact = await manual({ blackBands: { enabled: true, topText: 'My exact title' } }, DEFAULT_SETTINGS, 'Put My exact title in the top black band');
      assert.equal(exact.settings.blackBands?.topText, 'My exact title');
    });
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
  }
});
