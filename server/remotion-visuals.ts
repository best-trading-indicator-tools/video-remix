import { access, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { HeadlessBrowser } from "@remotion/renderer";
import type { VideoConfig } from "remotion";
import { runLocal } from "./auto-process.js";
import {
  browserPath,
  validateGraphic,
  type GraphicOptions,
} from "./visuals.js";

const parentDirectory = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const compiled = path.basename(parentDirectory) === "dist-server";
const projectRoot = compiled ? path.dirname(parentDirectory) : parentDirectory;

type BundleTask = {
  promise: Promise<string>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
};
let bundleTask: BundleTask | undefined;

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function localBrowser(): Promise<string | undefined> {
  if (process.env.REMOTION_BROWSER_EXECUTABLE) {
    try {
      await access(process.env.REMOTION_BROWSER_EXECUTABLE);
      return process.env.REMOTION_BROWSER_EXECUTABLE;
    } catch {
      return undefined;
    }
  }
  return browserPath();
}

/** A capability check never downloads a browser or compiles a composition. */
export async function remotionAvailable(): Promise<boolean> {
  try {
    await import("@remotion/renderer");
    await access(
      path.join(
        projectRoot,
        compiled ? "dist-remotion/index.html" : "remotion/index.tsx",
      ),
    );
    return !!(await localBrowser());
  } catch {
    return false;
  }
}

async function compositionBundle(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (compiled) {
    const directory = path.join(projectRoot, "dist-remotion");
    await access(path.join(directory, "index.html"));
    return directory;
  }
  // Development caches one fixed bundle per API process. The cache contains
  // code/fonts only, never a user's text. Production uses its build artifact.
  if (!bundleTask) {
    const task: BundleTask = {
      promise: Promise.resolve(""),
      controller: new AbortController(),
      consumers: 0,
      settled: false,
    };
    bundleTask = task;
    task.promise = (async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "video-remix-remotion-bundle-"),
      );
      try {
        await runLocal(
          process.execPath,
          [path.join(projectRoot, "scripts/build-remotion.mjs"), directory],
          {
            signal: task.controller.signal,
            timeout: 120_000,
            cwd: projectRoot,
          },
        );
        await access(path.join(directory, "index.html"));
        task.controller.signal.throwIfAborted();
        process.once("exit", () =>
          rmSync(directory, { recursive: true, force: true }),
        );
        return directory;
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        if (bundleTask === task) bundleTask = undefined;
        throw error;
      } finally {
        task.settled = true;
      }
    })();
  }
  const task = bundleTask;
  task.consumers++;
  try {
    return await abortable(task.promise, signal);
  } finally {
    task.consumers--;
    if (!task.settled && task.consumers === 0) {
      task.controller.abort();
      if (bundleTask === task) bundleTask = undefined;
      // Wait for the compiler process to stop and remove its partial bundle.
      await task.promise.catch(() => {});
    }
  }
}

/** Render one locally authored card; source text is never evaluated as code. */
export async function renderRemotionGraphic(
  options: GraphicOptions,
): Promise<void> {
  validateGraphic(options);
  options.signal.throwIfAborted();
  const chromePath = await localBrowser();
  if (!chromePath)
    throw new Error(
      "The local Remotion browser is not installed. Run npm run setup:visuals.",
    );
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(180_000),
  ]);
  const output = path.resolve(options.output);
  const directory = path.join(
    path.resolve(options.workDir),
    `remotion-card-${randomUUID()}`,
  );
  // Put the output temporary file alongside its destination for atomic rename,
  // including when a caller's work directory is on another volume.
  const temporaryOutput = path.join(
    path.dirname(output),
    `.remotion-${randomUUID()}.mp4`,
  );
  let browser: HeadlessBrowser | undefined;
  let closing: Promise<void> | undefined;
  const closeBrowser = () => {
    if (browser && !closing)
      closing = browser.close({ silent: true }).catch(() => {});
    return closing;
  };
  const renderer = await import("@remotion/renderer");
  const { cancelSignal, cancel } = renderer.makeCancelSignal();
  const abort = () => {
    cancel();
    void closeBrowser();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const serveUrl = await compositionBundle(signal);
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true });
    await mkdir(path.dirname(output), { recursive: true });
    browser = await renderer.openBrowser("chrome", {
      browserExecutable: chromePath,
      logLevel: "error",
      chromiumOptions: { gl: "swangle", headless: true },
    });
    signal.throwIfAborted();
    const inputProps = {
      text: options.text.trim(),
      caption: options.caption?.trim() || "",
      width: options.width,
      height: options.height,
      duration: options.duration,
    };
    // This fixed template has no asynchronous metadata. Passing its known
    // configuration also avoids opening a second page/server just to select
    // it, whose startup can race cancellation in Remotion 4.x.
    const composition: VideoConfig = {
      id: "EditorialIdea",
      width: options.width,
      height: options.height,
      fps: 30,
      durationInFrames: Math.round(options.duration * 30),
      props: inputProps,
      defaultProps: {},
      defaultCodec: null,
      defaultOutName: null,
      defaultVideoImageFormat: null,
      defaultPixelFormat: null,
      defaultProResProfile: null,
      defaultSampleRate: null,
    };
    signal.throwIfAborted();
    await renderer.renderMedia({
      composition,
      serveUrl,
      inputProps,
      puppeteerInstance: browser,
      browserExecutable: chromePath,
      outputLocation: temporaryOutput,
      codec: "h264",
      pixelFormat: "yuv420p",
      crf: 20,
      x264Preset: "veryfast",
      muted: true,
      concurrency: 1,
      disallowParallelEncoding: true,
      overwrite: false,
      cancelSignal,
      timeoutInMilliseconds: 20_000,
      logLevel: "error",
      offthreadVideoCacheSizeInBytes: 16 * 1024 * 1024,
      mediaCacheSizeInBytes: 16 * 1024 * 1024,
      // Remotion 4.x requires no network license lookup for local rendering.
      // Its license eligibility is documented separately in the README.
    });
    signal.throwIfAborted();
    if ((await stat(temporaryOutput)).size < 100)
      throw new Error("Remotion did not produce a complete motion card");
    await rename(temporaryOutput, output);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await closeBrowser();
    await rm(temporaryOutput, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}
