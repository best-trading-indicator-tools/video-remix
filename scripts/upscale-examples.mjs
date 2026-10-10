// Reproduce the checked-in demos with the same renderer used by the app.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
const sources = [
  { id: 'sintel', title: 'Sintel trailer', filename: 'sintel-trailer-original.mp4',
    url: 'https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4',
    sha256: '34bbd52a4b89fdf63c8ace50b268da26653a59508288100cd3c23de276db7931',
    attribution: '© copyright Blender Foundation | www.sintel.org', attributionUrl: 'https://durian.blender.org/sharing/' },
  { id: 'tears-of-steel', title: 'Tears of Steel', filename: 'tears-of-steel-original.webm',
    url: 'https://media.xiph.org/tearsofsteel/tears_of_steel_1080p.webm',
    sha256: '328253280a05e6b14a92f1f43d818d9b7d38ab5d3f6d5d98606198fd3daef2ff',
    attribution: '(CC) Blender Foundation | mango.blender.org', attributionUrl: 'https://mango.blender.org/sharing/' },
].map(source => ({ ...source, license: 'https://creativecommons.org/licenses/by/3.0/' }));
const comparisonsOnly = process.argv.includes('--comparisons-only');
if (!comparisonsOnly) await assertUpscaleInstalled();
await mkdir(directory, { recursive: true });
await mkdir(cache, { recursive: true });
const prepared = new Set();
const hashFile = async filename => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
};
async function prepareOriginal(sourceId) {
  const source = sources.find(item => item.id === sourceId);
  const original = path.join(cache, source.filename);
  if (prepared.has(sourceId)) return original;
  let matches = false;
  try { matches = await hashFile(original) === source.sha256; } catch { /* Download below. */ }
  if (!matches) {
    console.log(`Downloading licensed source: ${source.title}`);
    const response = await fetch(source.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Sample download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(original));
    assert.equal(await hashFile(original), source.sha256, 'Official sample changed; review before regenerating.');
  }
  prepared.add(sourceId);
  return original;
}
const samples = [
  { id: 'closeup-1080p', sourceId: 'sintel', title: 'Close-up · 360p → 1080p', start: 14, inputWidth: 640, inputHeight: 360, target: '1080' },
  { id: 'motion-4k', sourceId: 'sintel', title: 'Motion · 540p → 4K', start: 27, inputWidth: 960, inputHeight: 540, target: '2160' },
  { id: 'live-action-1080p', sourceId: 'tears-of-steel', title: 'Live action · 360p → 1080p', start: 32,
    sourceCrop: 'crop=1422:800:249:0', inputWidth: 640, inputHeight: 360, target: '1080',
    detailCrop: { width: 640, height: 480, x: 800, y: 110 }, posterFrame: 0 },
  { id: 'print-4k', sourceId: 'tears-of-steel', title: 'Printed edges · 540p → 4K', start: 80,
    sourceCrop: 'crop=1422:800:249:0', inputWidth: 960, inputHeight: 540, target: '2160',
    detailCrop: { width: 640, height: 480, x: 640, y: 260 }, posterFrame: 0 },
];
const selected = process.argv.slice(2).find(arg => arg !== '--comparisons-only');
if (selected) assert.ok(samples.some(sample => sample.id === selected), `Choose ${samples.map(sample => sample.id).join(', ')}.`);
let records = [];
try { records = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')).samples; }
catch { /* Fresh directory. */ }
for (const sample of samples) {
  if (selected && sample.id !== selected) continue;
  const input = path.join(directory, `${sample.id}-before.mp4`);
  const output = path.join(directory, `${sample.id}-ai.mp4`);
  const comparison = path.join(directory, `${sample.id}-comparison.mp4`);
  const previous = records.find(record => record.id === sample.id);
  if (!comparisonsOnly) {
    const original = await prepareOriginal(sample.sourceId);
    await runLocal('ffmpeg', ['-v', 'error', '-y', '-ss', String(sample.start), '-i', original, '-t', '2.5',
      '-vf', [sample.sourceCrop, `scale=${sample.inputWidth}:${sample.inputHeight}:flags=lanczos,setsar=1`].filter(Boolean).join(','),
      '-c:v', 'libx264', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', input]);
  }
  const source = await probeMedia(input);
  const started = performance.now();
  let last = -1;
  console.log(`${comparisonsOnly ? 'Refreshing comparisons for' : 'Rendering'} ${sample.title}`);
  const workDir = path.join(cache, `${sample.id}-work`);
  try {
    if (!comparisonsOnly) {
      await renderVideo({ input, output, source, workDir, signal: AbortSignal.timeout(60 * 60_000),
        settings: { ...DEFAULT_SETTINGS, upscale: sample.target },
        onProgress: value => { const step = Math.floor(value / 20); if (step !== last) { last = step; console.log(`${sample.id}: ${Math.round(value)}%`); } } });
    }
  } finally { await rm(workDir, { recursive: true, force: true }); }
  const seconds = comparisonsOnly ? previous?.seconds : Math.round((performance.now() - started) / 100) / 10;
  const result = await probeMedia(output);
  assert.equal(result.height, Number(sample.target));
  assert.equal(result.width, Number(sample.target) * 16 / 9);
  assert.equal(result.hasAudio, true);
  assert.equal(result.fps, source.fps);
  assert.ok(Math.abs(result.duration - source.duration) < 1 / source.fps / 2);
  const frames = await runLocal('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', output]);
  assert.equal(Number(frames.stdout.trim()), Math.round(source.duration * source.fps));
  // Identical input, timestamp and output-pixel crop. No extra sharpening or blur.
  const detail = sample.detailCrop;
  // Convert each decoded export to RGB before stacking: the AI intermediate can
  // carry full-range metadata while the ordinary export is limited-range YUV.
  // This keeps the PNG pair identical to the two individual decoded crops.
  const crop = detail ? `crop=${detail.width}:${detail.height}:${detail.x}:${detail.y},setsar=1,format=rgb24`
    : 'crop=960:1080:(iw-960)/2:(ih-1080)/2,setsar=1';
  const label = "fontcolor=white:fontsize=30:box=1:boxcolor=black@0.75:boxborderw=12:x=24:y=24";
  const detailLabel = "fontcolor=white:fontsize=24:x=20:y=12";
  let baseline = input;
  if (detail) {
    // Match the AI export's final H.264 settings for the ordinary-resize baseline.
    baseline = path.join(directory, `${sample.id}-resize.mp4`);
    await runLocal('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vf', `scale=${result.width}:${result.height}:flags=lanczos,setsar=1`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-threads', '2', '-c:a', 'copy', '-movflags', '+faststart', baseline]);
  }
  const comparisonFilter = `[0:v]${detail ? '' : `scale=${result.width}:${result.height}:flags=lanczos,`}${crop},` +
    `${detail ? `pad=iw:ih+48:0:48:color=black,drawtext=text='Ordinary resize':${detailLabel}` : `drawtext=text='Ordinary resize':${label}`}[a];` +
    `[1:v]${crop},${detail ? `pad=iw:ih+48:0:48:color=black,drawtext=text='Real-ESRGAN AI':${detailLabel}` : `drawtext=text='Real-ESRGAN AI':${label}`}[b];[a][b]hstack=inputs=2[v]`;
  await runLocal('ffmpeg', ['-v', 'error', '-y', '-i', baseline, '-i', output,
    '-filter_complex', comparisonFilter,
    '-map', '[v]', '-map', '1:a:0', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', comparison]);
  const poster = `${sample.id}-poster.${detail ? 'png' : 'jpg'}`;
  if (detail) {
    // Lossless still from the decoded exports, without resizing or JPEG recompression.
    await runLocal('ffmpeg', ['-v', 'error', '-y', '-i', baseline, '-i', output,
      '-filter_complex', `${comparisonFilter};[v]select=eq(n\\,${sample.posterFrame})[still]`,
      '-map', '[still]', '-frames:v', '1', path.join(directory, poster)]);
    for (const [kind, video] of [['resize', baseline], ['ai', output]]) {
      await runLocal('ffmpeg', ['-v', 'error', '-y', '-i', video,
        '-vf', `${crop},select=eq(n\\,${sample.posterFrame})`, '-frames:v', '1',
        path.join(directory, `${sample.id}-${kind}-detail.png`)]);
    }
  } else await runLocal('ffmpeg', ['-v', 'error', '-y', '-i', comparison, '-ss', '0.5', '-frames:v', '1', '-vf', 'scale=960:540', path.join(directory, poster)]);
  records = records.filter(record => record.id !== sample.id);
  records.push({ ...sample, seconds, before: { width: source.width, height: source.height }, after: result,
    generatedAt: comparisonsOnly ? previous?.generatedAt : new Date().toISOString(), comparisonUpdatedAt: new Date().toISOString(),
    files: { before: path.basename(input), ai: path.basename(output), comparison: path.basename(comparison), poster,
      ...(detail ? { resize: path.basename(baseline), resizeDetail: `${sample.id}-resize-detail.png`, aiDetail: `${sample.id}-ai-detail.png` } : {}) } });
}
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), runtime: await upscaleCapabilities(), sources,
  changes: '2.5-second excerpts, cropped where specified, downsampled and compressed at CRF 26 to make controlled inputs; AI enlarged by the app; comparisons use the same output-pixel crop and timestamp on both sides. New live-action posters are lossless, with no further resizing, blur or sharpening.',
  samples: records.map(record => ({ sourceId: 'sintel', ...record })).sort((a, b) => a.id.localeCompare(b.id)),
}, null, 2) + '\n');
console.log(`Examples ready: ${directory}`);
