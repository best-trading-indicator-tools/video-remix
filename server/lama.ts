import { access, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runLocal } from "./auto-process.js";

const parent = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.basename(parent) === "dist-server" ? path.dirname(parent) : parent;
const python = path.join(root, ".venv-watermark", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const script = path.join(root, "scripts/lama_inpaint.py");
const model = path.join(root, "scripts/models/big-lama.pt");
export class LamaError extends Error { readonly status = 422; }

/** Cheap early preflight. The worker verifies the full model hash before loading it. */
export async function assertLamaInstalled() {
  try {
    await Promise.all([access(python), access(script)]);
    if ((await stat(model)).size < 100_000_000) throw new Error("Incomplete model");
  } catch {
    throw new LamaError("Local LaMa is not installed. Run npm run setup:watermark on the server, then try again, or choose Blend surrounding pixels in Area fill.");
  }
}

export interface LamaTimeline {
  inputArgs: string[];
  filters: string[];
  fps: number;
  duration: number;
  onProgress?: (progress: number) => void;
}
export interface LamaArea {
  crop: { x: number; y: number; width: number; height: number };
  box: { x: number; y: number; width: number; height: number };
  alpha: string;
  output: string;
  intervals: { start: number; end: number }[];
}

// One model at a time across previews and concurrent exports keeps memory bounded.
let tail: Promise<void> = Promise.resolve();
export async function renderLama(areas: LamaArea[], timeline: LamaTimeline, workDir: string, temporary: string[], signal: AbortSignal) {
  if (!areas.length) return;
  signal.throwIfAborted();
  await assertLamaInstalled();
  const previous = tail;
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  tail = previous.then(() => turn);
  let abort!: () => void;
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("Cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
    signal.throwIfAborted();
    const plan = path.join(workDir, `watermark-lama-${randomUUID()}.json`);
    temporary.push(plan);
    const { onProgress, ...input } = timeline;
    await writeFile(plan, JSON.stringify({ ...input, areas }));
    onProgress?.(0);
    let buffered = "";
    try {
      await runLocal(python, [script, "--plan", plan], {
        cwd: workDir, signal, processGroup: true,
        timeout: Math.min(24 * 60 * 60_000, Math.max(120_000, timeline.duration * areas.length * 120_000)),
        onStdout: chunk => {
          buffered += chunk;
          const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const item = JSON.parse(line);
              if (Number.isFinite(item.progress)) onProgress?.(Math.min(100, Math.max(0, item.progress)));
            } catch { /* Ignore library diagnostics. */ }
          }
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new LamaError(`Local LaMa could not finish. ${error instanceof Error ? error.message : "Check the local installation."}`);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    release();
  }
}
