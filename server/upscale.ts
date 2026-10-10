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
export async function assertUpscaleInstalled() {
  try {
    await Promise.all([access(python), access(script)]);
    if ((await stat(model)).size < 4_000_000) throw new Error('Incomplete model');
  } catch {
    throw new UpscaleError('Local AI upscaling is not installed. Run npm run setup:upscale on the server, then retry.');
  }
}
export async function upscaleCapabilities() {
  try { await assertUpscaleInstalled(); return { installed: true }; }
  catch { return { installed: false }; }
}

export interface UpscaleTimeline {
  inputArgs: string[]; filters: string[]; width: number; height: number;
  outputWidth: number; outputHeight: number; fps: number; duration: number;
}
// Serialize model inference across bulk renders and previews to bound GPU memory.
let tail: Promise<void> = Promise.resolve();
export async function renderUpscale(timeline: UpscaleTimeline, workDir: string, temporary: string[], signal: AbortSignal,
  onProgress: (progress: number) => void): Promise<string> {
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
          try { const item = JSON.parse(line); if (Number.isFinite(item.progress)) onProgress(Math.min(100, Math.max(0, item.progress))); }
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
