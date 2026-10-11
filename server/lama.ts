import { access, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runLocal } from "./auto-process.js";
import { createLamaSetup } from "./lama-setup.js";

const parent = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = process.env.REMIX_RUNTIME_DIR || (path.basename(parent) === "dist-server" ? path.dirname(parent) : parent);
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
    throw new LamaError("Local LaMa needs setup. Retry the preview or export to install it automatically.");
  }
}

const setup = createLamaSetup(async (signal, report) => {
  let buffered = "";
  try {
    await runLocal(process.env.REMIX_NODE || process.execPath, [path.join(root, "scripts/setup-watermark.mjs"), "--ensure"], {
      cwd: root, signal, processGroup: true, timeout: 30 * 60_000,
      onStdout: chunk => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/u); buffered = (lines.pop() ?? "").slice(-4000);
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (typeof item.lamaSetup === "string") report(item.lamaSetup.slice(0, 200));
          } catch { /* Package-manager logs are not user-facing progress. */ }
        }
      },
    });
    await assertLamaInstalled();
  } catch (error) {
    signal.throwIfAborted();
    console.error("Automatic LaMa setup failed:", error);
    throw new LamaError("Local LaMa could not be installed automatically. Check your internet connection and free disk space, then retry the preview or export. " +
      (process.env.REMIX_DESKTOP === "1" ? "You can also retry Local object removal in Settings → Local tools." :
        "Run npm run setup:python to retry Python setup, or npm run setup:watermark for installation details.") +
      " To continue without a download, choose Blend surrounding pixels in Area fill.");
  }
});
export const lamaSetupStatus = setup.status;
export const stopLamaSetup = setup.stop;
export async function ensureLamaInstalled(signal: AbortSignal, onPhase?: (phase: string) => void) {
  try { await assertLamaInstalled(); } catch { setup.invalidate(); }
  await setup.ensure(signal, onPhase);
}

export interface LamaTimeline {
  inputArgs: string[];
  filters: string[];
  fps: number;
  duration: number;
  onProgress?: (progress: number) => void;
  onPhase?: (phase: string) => void;
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
  await ensureLamaInstalled(signal, timeline.onPhase);
  timeline.onPhase?.("Waiting for local LaMa reconstruction");
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
    const { onProgress, onPhase, ...input } = timeline;
    await writeFile(plan, JSON.stringify({ ...input, areas }));
    onProgress?.(0);
    onPhase?.("Reconstructing marked areas with local LaMa");
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
      onPhase?.("Rendering cleaned video");
    } catch (error) {
      signal.throwIfAborted();
      setup.invalidate();
      throw new LamaError(`Local LaMa could not finish. ${error instanceof Error ? error.message : "Check the local installation."}`);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    release();
  }
}
