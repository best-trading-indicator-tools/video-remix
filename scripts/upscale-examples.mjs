// Reproduce the checked-in demos with the same renderer used by the app.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { probeMedia, renderVideo } from '../server/engine.ts';
import { runLocal } from '../server/auto-process.ts';
import { assertUpscaleInstalled, upscaleCapabilities } from '../server/upscale.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(root, 'docs/upscale-examples');
const cache = path.join(root, 'output/upscale-examples');
const original = path.join(cache, 'sintel-trailer-original.mp4');
const sourceUrl = 'https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4';
const sourceHash = '34bbd52a4b89fdf63c8ace50b268da26653a59508288100cd3c23de276db7931';
await assertUpscaleInstalled();
await mkdir(directory, { recursive: true });
await mkdir(cache, { recursive: true });
let bytes;
try { bytes = await readFile(original); } catch { /* Download below. */ }
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sourceHash) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Sample download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sourceHash, 'Official sample changed; review before regenerating.');
  await writeFile(original, bytes);
}
const samples = [
  { id: 'closeup-1080p', title: 'Close-up · 360p → 1080p', start: 14, inputWidth: 640, inputHeight: 360, target: '1080' },
  { id: 'motion-4k', title: 'Motion · 540p → 4K', start: 27, inputWidth: 960, inputHeight: 540, target: '2160' },
];
const selected = process.argv[2];
if (selected) assert.ok(samples.some(sample => sample.id === selected), 'Choose closeup-1080p or motion-4k.');
let records = [];
if (selected) {
  try { records = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')).samples.filter(sample => sample.id !== selected); }
  catch { /* First sample in a fresh directory. */ }
}
for (const sample of samples) {
  if (selected && sample.id !== selected) continue;
  const input = path.join(directory, `${sample.id}-before.mp4`);
  const output = path.join(directory, `${sample.id}-ai.mp4`);
  const comparison = path.join(directory, `${sample.id}-comparison.mp4`);
  await runLocal('ffmpeg', ['-v', 'error', '-y', '-ss', String(sample.start), '-i', original, '-t', '2.5',
    '-vf', `scale=${sample.inputWidth}:${sample.inputHeight}:flags=lanczos,setsar=1`,
    '-c:v', 'libx264', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', input]);
  const source = await probeMedia(input);
  const started = performance.now();
  let last = -1;
  console.log(`Rendering ${sample.title}`);
  const workDir = path.join(cache, `${sample.id}-work`);
  try {
    await renderVideo({ input, output, source, workDir, signal: AbortSignal.timeout(60 * 60_000),
      settings: { ...DEFAULT_SETTINGS, upscale: sample.target },
      onProgress: value => { const step = Math.floor(value / 20); if (step !== last) { last = step; console.log(`${sample.id}: ${Math.round(value)}%`); } } });
  } finally { await rm(workDir, { recursive: true, force: true }); }
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  const result = await probeMedia(output);
  assert.equal(result.height, Number(sample.target));
  assert.equal(result.width, Number(sample.target) * 16 / 9);
  assert.equal(result.hasAudio, true);
  assert.equal(result.fps, source.fps);
  assert.ok(Math.abs(result.duration - source.duration) < 1 / source.fps / 2);
  const frames = await runLocal('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', output]);
  assert.equal(Number(frames.stdout.trim()), Math.round(source.duration * source.fps));
  // Same pixels and crop on both sides. Left is ordinary resizing, right is AI.
  const crop = 'crop=960:1080:(iw-960)/2:(ih-1080)/2,setsar=1';
  const label = "fontcolor=white:fontsize=30:box=1:boxcolor=black@0.75:boxborderw=12:x=24:y=24";
  await runLocal('ffmpeg', ['-v', 'error', '-y', '-i', input, '-i', output,
    '-filter_complex', `[0:v]scale=${result.width}:${result.height}:flags=lanczos,${crop},drawtext=text='Ordinary resize':${label}[a];` +
      `[1:v]${crop},drawtext=text='Real-ESRGAN AI':${label}[b];[a][b]hstack=inputs=2[v]`,
    '-map', '[v]', '-map', '1:a:0', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', comparison]);
  await runLocal('ffmpeg', ['-v', 'error', '-y', '-i', comparison, '-ss', '0.5', '-frames:v', '1', '-vf', 'scale=960:540',
    path.join(directory, `${sample.id}-poster.jpg`)]);
  records.push({ ...sample, seconds, before: { width: source.width, height: source.height }, after: result,
    generatedAt: new Date().toISOString(), files: { before: path.basename(input), ai: path.basename(output), comparison: path.basename(comparison) } });
}
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), runtime: await upscaleCapabilities(), sourceUrl,
  attribution: '© copyright Blender Foundation | www.sintel.org', license: 'https://creativecommons.org/licenses/by/3.0/',
  changes: '2.5-second excerpts, downsampled and compressed to make controlled inputs; AI enlarged by the app; comparisons cropped and labelled.',
  samples: records.sort((a, b) => a.id.localeCompare(b.id)),
}, null, 2) + '\n');
console.log(`Examples ready: ${directory}`);
