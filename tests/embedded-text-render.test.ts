import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { renderVideo, probeMedia } from '../server/engine.js';
import { detectEmbeddedText, EmbeddedTextError, readableCaptionReport, type EmbeddedTextReport } from '../server/embedded-text.js';
import { canRetryRender } from '../server/job-recovery.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
const exec = promisify(execFile), signal = new AbortController().signal;
const regions = [{ x: .125, y: 2 / 3, width: .75, height: 2 / 9 }];

async function fixture(directory: string) {
  const input = path.join(directory, 'source.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=640x360:r=24:d=4,drawbox=x=320:y=0:w=320:h=360:color=green:t=fill',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-vf',
    "drawbox=x=0:y=230:w=640:h=100:color=black:t=fill,drawtext=fontfile=public/caption-fonts/Poppins-Bold.ttf:text='READ THIS TEXT':fontsize=38:fontcolor=white:x=(w-text_w)/2:y=255",
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
  return input;
}
async function pixels(file: string, filter = 'crop=480:80:80:240') {
  return (await exec('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', file, '-frames:v', '1', '-vf', filter, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 3_000_000 })).stdout;
}
const difference = (a: Buffer, b: Buffer) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length;

test('real renders keep original caption pixels readable while flipping the rest, across speed and source cuts', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'readable-render-'));
  try {
    const input = await fixture(directory), source = await probeMedia(input);
    const originalHash = createHash('sha256').update(await readFile(input)).digest('hex');
    const reference = path.join(directory, 'reference.mp4'), baseline = path.join(directory, 'mirrored.mp4');
    await renderVideo({ input, source, output: reference, settings: DEFAULT_SETTINGS, signal, workDir: path.join(directory, 'reference-work'), onProgress: () => {} });
    const original = await pixels(reference);
    await renderVideo({ input, source, output: baseline, settings: { ...DEFAULT_SETTINGS, mirror: true }, signal, workDir: path.join(directory, 'base-work'), onProgress: () => {} });
    const reversed = await pixels(baseline);
    assert.ok(difference(original, reversed) > 10, 'The original text is asymmetric');
    for (const speed of [.5, 2]) {
      const output = path.join(directory, `${speed}.mp4`);
      const manualRegions = speed === 2 ? [...regions, { x: .1, y: .1, width: .2, height: .1 }] : regions;
      let report: EmbeddedTextReport | undefined;
      await renderVideo({ input, source, output, settings: { ...DEFAULT_SETTINGS, speed, mirror: true, preserveEmbeddedText: true, embeddedTextRegions: manualRegions,
        segments: [{ start: 0, end: 1 }, { start: 2, end: 3 }] }, signal, workDir: path.join(directory, `work-${speed}`), onProgress: () => {}, onEmbeddedText: value => { report = value; } });
      assert.deepEqual(report, { method: 'manual', regions: manualRegions });
      const readableDifference = difference(original, await pixels(output)), mirroredDifference = difference(original, reversed);
      assert.ok(readableDifference < mirroredDifference / 4, `The original lettering survives two flips (${readableDifference} vs ${mirroredDifference})`);
      const left = await pixels(output, 'crop=2:2:40:40,scale=1:1');
      assert.ok(left[1]! > left[0]! + 60, 'Outside the caption area, the source is flipped');
      const info = await probeMedia(output); assert.ok(Math.abs(info.duration - 2 / speed) < .1); assert.equal(info.hasAudio, true);
    }
    assert.equal(createHash('sha256').update(await readFile(input)).digest('hex'), originalHash);
    assert.equal(await readableCaptionReport({ ...DEFAULT_SETTINGS, preserveEmbeddedText: true }, '/missing', [], signal), undefined, 'No OCR when mirror is off');
    assert.equal(canRetryRender(new EmbeddedTextError('Choose manual caption areas')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('automatic local OCR finds actual fixed lettering, caches only areas, renders it and fails clearly without OCR', { timeout: 90000 }, async t => {
  try { if (!(await exec('tesseract', ['--list-langs'])).stdout.split(/\r?\n/u).includes('eng')) return t.skip('Local English OCR unavailable'); }
  catch { return t.skip('Local OCR unavailable'); }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'readable-ocr-')), previous = process.env.REMIX_OCR_SCRIPT;
  try {
    const input = await fixture(directory), cuts = [{ start: 0, end: 4 }], cache = path.join(directory, 'cache');
    const found = await detectEmbeddedText(input, cuts, signal, cache);
    assert.equal(found.length, 1); assert.ok(found[0]!.y > .65 && found[0]!.y < .8);
    const saved = await readFile(path.join(cache, (await readdir(cache))[0]!), 'utf8');
    assert.ok(!saved.includes('READ THIS TEXT') && !saved.includes(directory), 'No OCR text or file paths persisted');
    const output = path.join(directory, 'auto.mp4');
    let report: EmbeddedTextReport | undefined;
    await renderVideo({ input, source: await probeMedia(input), output, settings: { ...DEFAULT_SETTINGS, mirror: true, preserveEmbeddedText: true }, signal,
      workDir: path.join(directory, 'work'), onProgress: () => {}, onEmbeddedText: value => { report = value; } });
    assert.equal(report?.method, 'automatic');
    const frame = path.join(directory, 'result.png');
    await exec('ffmpeg', ['-v', 'error', '-i', output, '-frames:v', '1', '-update', '1', frame]);
    assert.match((await exec('tesseract', [frame, 'stdout', '--psm', '11'])).stdout, /READ THIS TEXT/);
    const missing = path.join(directory, 'missing-ocr.cjs'); await writeFile(missing, 'console.log("List of available languages (0):");'); process.env.REMIX_OCR_SCRIPT = missing;
    assert.deepEqual(await detectEmbeddedText(input, cuts, signal, cache), found, 'Unchanged source reuses inspected areas');
    await assert.rejects(detectEmbeddedText(input, [{ start: 1, end: 3 }], signal, cache), /manual caption areas/);
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(detectEmbeddedText(input, cuts, cancelled.signal, cache), { name: 'AbortError' });
  } finally { if (previous === undefined) delete process.env.REMIX_OCR_SCRIPT; else process.env.REMIX_OCR_SCRIPT = previous; await rm(directory, { recursive: true, force: true }); }
});
