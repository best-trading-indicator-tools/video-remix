import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { embeddedTextRegionsSchema, type EmbeddedTextRegion } from '../shared/embedded-text.js';
import type { EditSegment, RemixSettings } from '../shared/types.js';
import { captionSampleTimes, ocrCommand, readCaptionLines } from './source-captions.js';
import { MEDIA_INPUT_ARGS, runLocal } from './auto-process.js';
import { paths } from './config.js';

export class EmbeddedTextError extends Error { readonly status = 422; constructor(message: string) { super(message); this.name = 'EmbeddedTextError'; } }
export interface EmbeddedTextReport { method: 'automatic' | 'manual'; regions: EmbeddedTextRegion[] }
type Box = EmbeddedTextRegion;
const right = (box: Box) => box.x + box.width, bottom = (box: Box) => box.y + box.height;
const union = (a: Box, b: Box): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
  width: Math.max(right(a), right(b)) - Math.min(a.x, b.x), height: Math.max(bottom(a), bottom(b)) - Math.min(a.y, b.y) });
const overlaps = (a: Box, b: Box) => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);

/** Repeated, stationary OCR areas only. Words are never used to reconstruct the picture. */
export function fixedCaptionRegions(samples: Box[][]): Box[] {
  const groups: { box: Box; anchor: Box; frames: Set<number> }[] = [];
  samples.forEach((lines, frame) => lines.forEach(line => {
    const group = groups.find(item => Math.abs(item.anchor.y + item.anchor.height / 2 - line.y - line.height / 2) < .025 &&
      Math.abs(item.anchor.x + item.anchor.width / 2 - line.x - line.width / 2) < .045);
    if (group) { group.box = union(group.box, line); group.frames.add(frame); }
    else groups.push({ box: line, anchor: line, frames: new Set([frame]) });
  }));
  const boxes = groups.filter(group => group.frames.size >= Math.max(3, Math.ceil(samples.length * .6))).map(({ box }) => {
    const x = Math.max(0, box.x - .012), y = Math.max(0, box.y - .012);
    return { x, y, width: Math.min(1, right(box) + .012) - x, height: Math.min(1, bottom(box) + .012) - y };
  });
  // OCR returns both individual lines and combined two-line captions.
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    if (!overlaps(boxes[i]!, boxes[j]!)) continue;
    boxes[i] = union(boxes[i]!, boxes[j]!); boxes.splice(j, 1); i = -1; break;
  }
  return embeddedTextRegionsSchema.parse(boxes.sort((a, b) => a.y - b.y || a.x - b.x));
}

export async function detectEmbeddedText(input: string, cuts: EditSegment[], signal: AbortSignal,
  cacheDir = path.join(paths.analysis, 'embedded-text')): Promise<Box[]> {
  signal.throwIfAborted();
  const file = await realpath(input), info = await stat(file);
  if (!info.isFile()) throw new EmbeddedTextError('The original video is unavailable for caption detection.');
  const identity = createHash('sha256').update(JSON.stringify({ version: 1, file, size: info.size, mtime: info.mtimeMs,
    inode: info.ino, cuts: cuts.map(({ start, end }) => ({ start, end })) })).digest('hex');
  const destination = path.join(cacheDir, `${identity}.json`);
  try {
    const cached = JSON.parse(await readFile(destination, 'utf8'));
    const parsed = embeddedTextRegionsSchema.safeParse(cached.regions);
    if (cached.identity === identity && parsed.success && parsed.data.length) return parsed.data;
  } catch { signal.throwIfAborted(); }
  const budget = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remix-readable-captions-'));
  try {
    const availableCommand = ocrCommand(['--list-langs']);
    const available = await runLocal(availableCommand.binary, availableCommand.args, { signal: budget, timeout: 5000 });
    if (!`${available.stdout}\n${available.stderr}`.split(/\r?\n/u).some(line => line.trim() === 'eng'))
      throw new EmbeddedTextError('Automatic caption areas need the local English OCR model. Choose manual caption areas instead.');
    const samples: Box[][] = [];
    for (const [index, time] of captionSampleTimes(cuts).entries()) {
      budget.throwIfAborted();
      const frame = path.join(directory, `frame-${index}.png`);
      await runLocal('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-threads', '1', ...MEDIA_INPUT_ARGS,
        '-ss', time.toFixed(6), '-i', file, '-map', '0:V:0', '-frames:v', '1', '-an', '-sn', '-dn',
        '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease,setsar=1', '-filter_threads', '1', '-threads', '1', '-update', '1', frame],
      { signal: budget, timeout: 5000 });
      const header = Buffer.alloc(24), handle = await open(frame, 'r');
      try { await handle.read(header, 0, 24, 0); } finally { await handle.close(); }
      const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
      if (header.toString('hex', 0, 8) !== '89504e470d0a1a0a' || width < 2 || height < 2 || width > 1280 || height > 1280) throw new Error('Invalid frame');
      const command = ocrCommand([frame, 'stdout', '-l', 'eng', '--psm', '11', 'tsv']);
      const result = await runLocal(command.binary, command.args, { signal: budget, timeout: process.env.REMIX_OCR_SCRIPT ? 10_000 : 5000 });
      samples.push(readCaptionLines(result.stdout, width, height));
      await rm(frame, { force: true });
    }
    const regions = fixedCaptionRegions(samples);
    if (!regions.length) throw new EmbeddedTextError('No reliable fixed caption area was found. Choose manual caption areas and preview again, or turn off Keep embedded captions readable.');
    const current = await stat(file);
    if (current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ino !== info.ino)
      throw new EmbeddedTextError('The source changed during caption detection. Import it again before previewing.');
    await mkdir(cacheDir, { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ identity, regions }), { mode: 0o600, flag: 'wx' });
      budget.throwIfAborted(); await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    return regions;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof EmbeddedTextError) throw error;
    throw new EmbeddedTextError(budget.aborted
      ? 'Caption detection took too long. Choose manual caption areas to preview and export.'
      : 'Automatic caption areas could not be determined reliably. Choose manual caption areas to preview and export.');
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

/** Counter-flip source regions before the ordinary picture flip. No OCR text substitution. */
export function embeddedTextFilters(regions: Box[], width: number, height: number): string[] {
  return embeddedTextRegionsSchema.parse(regions).map((region, index) => {
    const x = Math.floor(region.x * width / 2) * 2, y = Math.floor(region.y * height / 2) * 2;
    const w = Math.min(width, Math.ceil(right(region) * width / 2) * 2) - x;
    const h = Math.min(height, Math.ceil(bottom(region) * height / 2) * 2) - y;
    const label = `readable${index}`;
    return `split=2[${label}base][${label}text];[${label}text]crop=${w}:${h}:${x}:${y},hflip[${label}fixed];[${label}base][${label}fixed]overlay=${x}:${y}:shortest=1`;
  });
}

export async function readableCaptionReport(settings: RemixSettings, input: string, cuts: EditSegment[], signal: AbortSignal,
  onPhase?: (message: string) => void): Promise<EmbeddedTextReport | undefined> {
  if (!settings.mirror || !settings.preserveEmbeddedText) return;
  const manual = embeddedTextRegionsSchema.parse(settings.embeddedTextRegions ?? []);
  if (manual.length) return { method: 'manual', regions: manual };
  onPhase?.('Finding fixed embedded caption areas');
  return { method: 'automatic', regions: await detectEmbeddedText(input, cuts, signal) };
}
