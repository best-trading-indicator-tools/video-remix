import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { captionCorrectionsSchema, correctCaptionCues, correctCaptionText } from '../shared/caption-corrections.js';
import { DEFAULT_CAPTION_STYLE, applyCaptionStyleChange } from '../shared/caption-style.js';
import { TITLE_DESIGNS, titleOverlay, resizeTextOverlay } from '../shared/text-overlays.js';
import { DEFAULT_SETTINGS, DEFAULT_AUTO_OPTIONS, type EditPlan } from '../shared/types.js';
import { settingsSchema, autoOptionsSchema } from '../server/schema.js';
import { prepareCaptionCorrections } from '../server/caption-corrections.js';
import { captionCuesSrt, parseCaptionCues } from '../server/edit-plan.js';
import { probeMedia, renderVideo, burnOutputCaptions } from '../server/engine.js';
import { captureFinishingPreset, restoreFinishingPresets } from '../shared/finishing-presets.js';
import type { StoredJob } from '../server/store.js';

const correction = (find: string, replace: string, wholeWord = true, caseSensitive = false) => ({ find, replace, wholeWord, caseSensitive });

test('bulk corrections respect Unicode words, case, literal replacement text, deletion and cue timing', () => {
  assert.equal(correctCaptionText('Acme acme ACME Acmeology', [correction('acme', 'ACME')]).text, 'ACME ACME ACME Acmeology');
  assert.equal(correctCaptionText('кот котик КОТ', [correction('кот', 'cat')]).text, 'cat котик cat');
  assert.equal(correctCaptionText('C++ is useful', [correction('C++', '$& is literal')]).text, '$& is literal is useful');
  assert.equal(correctCaptionText('hello\nworld', [correction('hello world', 'hi')]).text, 'hi');
  assert.equal(correctCaptionText('ACME acme', [correction('acme', 'x', true, true)]).text, 'ACME x');
  const cues = [{ id: 'a', start: 1, end: 2, text: 'um' }, { id: 'b', start: 2, end: 3, text: 'acme hello' }];
  const result = correctCaptionCues(cues, [correction('um', ''), correction('acme', 'ACME')]);
  assert.deepEqual(result, { captions: [{ ...cues[1], text: 'ACME hello' }], matches: 2, changed: 2 });
  assert.equal(cues[0]!.text, 'um');
  for (const rule of [correction('', 'x'), correction('x', '\n\n'), correction('x', '{\\pos(1,1)}'), correction('x', '<b>x</b>')])
    assert.equal(captionCorrectionsSchema.safeParse([rule]).success, false);
  assert.throws(() => correctCaptionText('x '.repeat(100), [correction('x', 'longword')]), /500/);
});

test('animation changes preserve each batch target’s font and position; title designs and correction rules survive APIs and presets', () => {
  const target = { ...DEFAULT_CAPTION_STYLE, fontFamily: 'serif' as const, fontSize: 30, bottomPercent: 50 };
  const updated = applyCaptionStyleChange(target, DEFAULT_CAPTION_STYLE, { ...DEFAULT_CAPTION_STYLE, animation: 'pop' });
  assert.deepEqual(updated, { ...target, animation: 'pop' });
  const captionCorrections = [correction('acme', 'ACME')];
  for (const design of TITLE_DESIGNS) {
    const textOverlays = [titleOverlay(randomUUID(), design.id, 'Our new title')];
    assert.equal(textOverlays[0]!.text, 'Our new title');
    assert.equal(textOverlays[0]!.style.animation, design.style.animation);
    const settings = { ...DEFAULT_SETTINGS, captionStyle: updated, captionCorrections, textOverlays };
    assert.deepEqual(settingsSchema.parse(settings).textOverlays, textOverlays);
    assert.deepEqual(autoOptionsSchema.parse({ ...DEFAULT_AUTO_OPTIONS, captionStyle: updated, captionCorrections, textOverlays }).captionCorrections, captionCorrections);
    for (const mode of ['auto', 'manual'] as const) {
      const preset = captureFinishingPreset(mode, 'My captions', settings, mode);
      const restored = restoreFinishingPresets({ version: 1, presets: [preset] })[0]!;
      assert.deepEqual(restored.settings.captionCorrections, captionCorrections);
      assert.equal(restored.settings.captionStyle?.animation, 'pop');
      assert.equal('textOverlays' in restored.settings, false, 'Saving a caption preset does not copy a video’s titles');
    }
  }
  assert.deepEqual(resizeTextOverlay({ fontSize: 20, widthPercent: 60 }, 100, 0, 200, 80), { fontSize: 30, widthPercent: 90 });
  assert.deepEqual(resizeTextOverlay({ fontSize: 20, widthPercent: 60 }, 50, 0, 100, 40), { fontSize: 30, widthPercent: 90 });
  assert.deepEqual(resizeTextOverlay({ fontSize: 20, widthPercent: 60 }, -200, 0, 200, 80), { fontSize: 12, widthPercent: 10 });
});

test('corrections reach saved plans and SRT exactly once across retries, without modifying uploaded subtitles', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'caption-corrections-'));
  try {
    const file = path.join(dir, 'source.srt'), original = '1\n00:00:00,000 --> 00:00:01,000\na\n';
    await writeFile(file, original);
    const settings = { ...DEFAULT_SETTINGS, captionCorrections: [correction('a', 'aa', false)] };
    const plan: EditPlan = { version: 1, revision: 1, sourceId: 'source', sourceDuration: 2, outputDuration: 2, createdAt: new Date().toISOString(),
      settings: structuredClone(settings), cuts: [{ start: 0, end: 2 }], captions: parseCaptionCues(original), visuals: [], media: [], narration: false };
    const job = { id: 'test', settings: structuredClone(settings), editPlan: plan } as StoredJob;
    const result = await prepareCaptionCorrections(job, file, dir);
    assert.equal(result.applied, true);
    assert.equal(job.editPlan!.captions[0]!.text, 'aa');
    assert.equal(await readFile(result.subtitlePath!, 'utf8'), captionCuesSrt(job.editPlan!.captions));
    const reloaded = JSON.parse(JSON.stringify(job)) as StoredJob;
    await prepareCaptionCorrections(reloaded, result.subtitlePath, dir);
    assert.equal(reloaded.editPlan!.captions[0]!.text, 'aa', 'A retry must not expand aa to aaaa');
    assert.equal(await readFile(file, 'utf8'), original);
    const uploaded = { id: 'upload', settings } as StoredJob;
    const first = await prepareCaptionCorrections(uploaded, file, dir);
    const expected = await readFile(first.subtitlePath!, 'utf8');
    const second = await prepareCaptionCorrections(uploaded, file, dir);
    assert.equal(await readFile(second.subtitlePath!, 'utf8'), expected, 'Imported SRT retries start from original text');
    const removed = await prepareCaptionCorrections({ id: 'remove', settings: { ...DEFAULT_SETTINGS, captionCorrections: [correction('a', '')] } } as StoredJob, file, dir);
    assert.equal(removed.subtitlePath, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all animated styles change real exported pixels for subtitles and independent titles', { timeout: 60000 }, async () => {
  const exec = promisify(execFile), dir = await mkdtemp(path.join(tmpdir(), 'text-animation-'));
  const ffmpeg = (...args: string[]) => exec('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  try {
    const input = path.join(dir, 'source.mp4'), subtitlePath = path.join(dir, 'captions.srt');
    await ffmpeg('-f', 'lavfi', '-i', 'color=black:s=480x270:r=30:d=2', '-c:v', 'libx264', '-threads', '1', input);
    await writeFile(subtitlePath, '1\n00:00:00,000 --> 00:00:02,000\nONE TWO THREE\n');
    const source = await probeMedia(input);
    for (const animation of ['fade', 'pop', 'slide', 'typewriter', 'words'] as const) {
      for (const mode of ['caption', 'title'] as const) {
        const output = path.join(dir, `${animation}-${mode}.mp4`), style = { ...DEFAULT_CAPTION_STYLE, fontFamily: 'poppins' as const, fontSize: 25, bottomPercent: 40, animation, animationDuration: .5, outlineWidth: 0 };
        if (mode === 'caption') await burnOutputCaptions({ input, output, subtitlePath, style, workDir: dir, signal: new AbortController().signal });
        else { const title = titleOverlay(randomUUID(), 'bold', 'ONE TWO THREE', 0, 2); title.style = style;
          await renderVideo({ input, output, source, settings: { ...DEFAULT_SETTINGS, textOverlays: [title] }, workDir: dir, signal: new AbortController().signal, onProgress() {} }); }
        const frames = [];
        for (const time of [.1, 1.5]) {
          const pixels = (await ffmpeg('-ss', String(time), '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1')).stdout;
          let count = 0, brightness = 0, sumY = 0, minX = 480, maxX = 0;
          for (let i = 0; i < pixels.length; i += 3) if (pixels[i]! > 20) { const x = i / 3 % 480, y = Math.floor(i / 3 / 480); count++; brightness += pixels[i]!; sumY += y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
          frames.push({ count, brightness, y: sumY / count, width: maxX - minX });
        }
        const [early, late] = frames;
        assert.ok(early!.count > 5 && late!.count > 30, `${mode} ${animation}: text is visible`);
        if (animation === 'slide') assert.ok(early!.y > late!.y + 2, `${mode}: text moves upward`);
        else if (animation === 'pop') assert.ok(early!.width < late!.width, `${mode}: text scales up`);
        else if (animation === 'fade') assert.ok(early!.brightness < late!.brightness / 2, `${mode}: text fades in`);
        else assert.ok(early!.count < late!.count * .75, `${mode}: more text is revealed over time`);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
