import { access, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runLocal } from './auto-process.js';

const parent = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.basename(parent) === 'dist-server' ? path.dirname(parent) : parent;
const python = path.join(root, '.venv-upscale', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const script = path.join(root, 'scripts/upscale_video.py');
const model = path.join(root, 'scripts/models/realesr-general-x4v3.pth');
export class UpscaleError extends Error { readonly status = 422; }
export interface UpscaleCapabilities {
  installed: boolean; ready: boolean; device?: 'cpu' | 'mps' | 'cuda'; error?: string; fallback?: string;
}
async function inspectRuntime(): Promise<UpscaleCapabilities> {
  try {
    await Promise.all([access(python), access(script)]);
    if ((await stat(model)).size < 4_000_000) throw new Error('Incomplete model');
  } catch {
    return { installed: false, ready: false, error: 'Local AI upscaling is not installed. Run npm run setup:upscale on the server, then retry.' };
  }
  try {
    const { stdout } = await runLocal(python, [script, '--check'], { cwd: root, timeout: 90_000, processGroup: true });
    const check = JSON.parse(stdout.trim().split('\n').at(-1)!);
    if (check.available !== true || !['cpu', 'mps', 'cuda'].includes(check.device)) throw new Error('The inference self-check did not pass.');
    return { installed: true, ready: true, device: check.device, ...(check.fallback ? { fallback: check.fallback } : {}) };
  } catch (error) {
    return { installed: true, ready: false, error: `AI upscaler self-check failed. ${error instanceof Error ? error.message : 'Run npm run setup:upscale again.'}` };
  }
}
let cached: { until: number; device: string | undefined; value: Promise<UpscaleCapabilities> } | undefined;
export function upscaleCapabilities(): Promise<UpscaleCapabilities> {
  if (!cached || cached.until < Date.now() || cached.device !== process.env.UPSCALE_DEVICE) {
    const entry = { until: Infinity, device: process.env.UPSCALE_DEVICE, value: inspectRuntime() };
    cached = entry;
    void entry.value.then(result => { entry.until = Date.now() + (result.ready ? 60_000 : 5_000); });
  }
  return cached.value;
}
export async function assertUpscaleInstalled() {
  const capability = await upscaleCapabilities();
  if (!capability.ready) throw new UpscaleError(capability.error ?? 'AI upscaling is not ready. Run npm run setup:upscale.');
}

export interface UpscaleTimeline {
  inputArgs: string[]; filters: string[]; width: number; height: number;
  outputWidth: number; outputHeight: number; fps: number; duration: number;
}
// Serialize model inference across bulk renders and previews to bound GPU memory.
let tail: Promise<void> = Promise.resolve();
export async function renderUpscale(timeline: UpscaleTimeline, workDir: string, temporary: string[], signal: AbortSignal,
  onProgress: (progress: number) => void, onStatus?: (status: string) => void): Promise<string> {
  signal.throwIfAborted();
  await assertUpscaleInstalled();
  const previous = tail;
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  tail = previous.then(() => turn);
  let abort!: () => void;
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
    signal.throwIfAborted();
    const filename = `upscale-${randomUUID()}.mkv`;
    const plan = path.join(workDir, `upscale-${randomUUID()}.json`);
    const output = path.join(workDir, filename);
    temporary.push(plan, output);
    await writeFile(plan, JSON.stringify({ ...timeline, output }));
    onProgress(0);
    let buffered = '';
    await runLocal(python, [script, '--plan', plan], {
      cwd: workDir, signal, processGroup: true,
      timeout: 24 * 60 * 60_000,
      onStdout: chunk => {
        buffered += chunk;
        const lines = buffered.split('\n'); buffered = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (Number.isFinite(item.progress)) onProgress(Math.min(100, Math.max(0, item.progress)));
            if (typeof item.status === 'string') onStatus?.(item.status);
            else if (['cpu', 'mps', 'cuda'].includes(item.device)) onStatus?.(`Upscaling with local AI · ${item.device === 'cpu' ? 'CPU (slower)' : item.device === 'mps' ? 'Apple GPU' : 'NVIDIA GPU'}`);
          }
          catch { /* Library diagnostics are not progress. */ }
        }
      },
    });
    return filename;
  } catch (error) {
    signal.throwIfAborted();
    throw new UpscaleError(`AI upscaling could not finish. ${error instanceof Error ? error.message : 'Check the local installation.'}`);
  } finally {
    signal.removeEventListener('abort', abort);
    release();
  }
}
