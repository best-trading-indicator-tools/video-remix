import { access, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { FocalPoint, VisualSource } from "../shared/types.js";

/** Local, preselected media on the final edited timeline. Sound is never used. */
export interface SupportingVisual {
  path: string;
  start: number;
  end: number;
  sourceStart?: number;
  focalPoint?: FocalPoint;
  label: string;
  kind: "broll" | "graphic";
  visualSource?: VisualSource;
}

export interface GraphicOptions {
  text: string;
  caption?: string;
  width: number;
  height: number;
  duration: number;
  output: string;
  workDir: string;
  signal: AbortSignal;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (letter) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[letter]!,
  );
}

export function validateGraphic(
  options: Pick<
    GraphicOptions,
    "text" | "caption" | "width" | "height" | "duration"
  >,
): void {
  if (
    !options.text.trim() ||
    options.text.length > 180 ||
    options.text.includes("\0") ||
    (options.caption?.length ?? 0) > 160 ||
    options.caption?.includes("\0")
  )
    throw new Error(
      "Motion cards need a short, readable title and supporting line",
    );
  if (
    ![options.width, options.height].every(
      (n) => Number.isInteger(n) && n >= 64 && n <= 4096 && n % 2 === 0,
    ) ||
    options.width * options.height > 8_294_400 ||
    !Number.isFinite(options.duration) ||
    options.duration < 0.5 ||
    options.duration > 10
  )
    throw new Error("Invalid motion card dimensions or duration");
}

/** An authored, fixed HTML template: source text never becomes JavaScript/CSS. */
export function graphicHtml(
  options: Pick<
    GraphicOptions,
    "text" | "caption" | "width" | "height" | "duration"
  >,
): string {
  validateGraphic(options);
  const { width, height, duration } = options;
  const short = Math.min(width, height);
  let titleSize = Math.round(
    short *
      (options.text.length > 100
        ? 0.074
        : options.text.length > 55
          ? 0.09
          : 0.115),
  );
  const inset = Math.round(short * 0.095);
  const contentWidth = width - inset * 2;
  const captionSize = Math.round(short * 0.04);
  // Reserve the lower quarter for burned captions, including landscape cards.
  // A conservative line estimate reduces long titles before the browser lays
  // them out, instead of clipping or covering the spoken-word caption rail.
  const estimateLines = (text: string, size: number) => {
    const columns = Math.max(1, Math.floor(contentWidth / (size * 0.7)));
    let lines = 1;
    let used = 0;
    for (const word of text.split(/\s+/u)) {
      const count = Array.from(word).reduce(
        (sum, char) => sum + (/[^\u0000-\u024f]/u.test(char) ? 2 : 1),
        0,
      );
      if (used && used + count + 1 > columns) {
        lines++;
        used = 0;
      }
      lines += Math.floor(Math.max(0, count - 1) / columns);
      used += (count % columns) + (used ? 1 : 0);
    }
    return lines;
  };
  const captionHeight = options.caption?.trim()
    ? estimateLines(options.caption, captionSize) * captionSize * 1.4 +
      short * 0.04
    : 0;
  while (
    titleSize > short * 0.035 &&
    estimateLines(options.text, titleSize) * titleSize * 1.13 + captionHeight >
      height * 0.43
  )
    titleSize--;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Supporting idea</title>
<style>
@font-face{font-family:Inter;font-style:normal;font-weight:400;src:url('./inter-400.woff2') format('woff2')}
@font-face{font-family:Inter;font-style:normal;font-weight:700;src:url('./inter-700.woff2') format('woff2')}
*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#101214;color:#fff;font-family:Inter,sans-serif}
.root{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:linear-gradient(135deg,#14191c,#101214 72%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:${Math.round(short * 0.08)}px ${Math.round(short * 0.08)}px}
.line{position:absolute;top:17%;left:${inset}px;width:${Math.round(short * 0.16)}px;height:${Math.max(3, Math.round(short * 0.008))}px;background:#ff865e;transform-origin:left;animation:line-in .55s cubic-bezier(.2,.8,.2,1) both}
.content{position:absolute;top:25%;left:${inset}px;right:${inset}px;max-height:46%;display:flex;flex-direction:column;gap:${Math.round(short * 0.04)}px}
h1{margin:0;font-size:${titleSize}px;line-height:1.13;letter-spacing:-.035em;font-weight:700;overflow-wrap:anywhere;white-space:pre-line;animation:rise .65s cubic-bezier(.2,.8,.2,1) .06s both}
p{margin:0;color:#b5c8bf;font-size:${Math.round(short * 0.04)}px;line-height:1.4;max-width:92%;overflow-wrap:anywhere;animation:rise .6s cubic-bezier(.2,.8,.2,1) .2s both}
.edge{position:absolute;right:-${Math.round(short * 0.18)}px;top:-${Math.round(short * 0.12)}px;width:${Math.round(short * 0.58)}px;height:${Math.round(short * 0.58)}px;border:${Math.max(2, Math.round(short * 0.002))}px solid #ff865e35;border-radius:50%;animation:drift ${duration}s ease-out both}
.progress{position:absolute;left:${inset}px;right:${inset}px;bottom:29%;height:${Math.max(2, Math.round(short * 0.004))}px;background:#ffffff12}
.progress:after{content:"";display:block;width:100%;height:100%;background:#ff865e;transform-origin:left;animation:line-in ${duration}s linear both}
@keyframes rise{from{opacity:0;transform:translateY(${Math.round(short * 0.04)}px)}to{opacity:1;transform:translateY(0)}}
@keyframes line-in{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes drift{from{transform:translate(0,0) scale(.94)}to{transform:translate(-${Math.round(short * 0.05)}px,${Math.round(short * 0.04)}px) scale(1.04)}}
</style></head><body>
<div class="root" data-composition-id="supporting-idea" data-no-timeline data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
<div class="grid"></div><div class="edge"></div><div class="line"></div>
<div class="content"><h1>${escapeHtml(options.text.trim())}</h1>${options.caption?.trim() ? `<p>${escapeHtml(options.caption.trim())}</p>` : ""}</div>
<div class="progress"></div></div></body></html>`;
}

export async function browserPath(): Promise<string | undefined> {
  const puppeteer = await import("puppeteer");
  const candidates = [
    process.env.PRODUCER_HEADLESS_SHELL_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ];
  for (const headless of [true, "shell"] as const) {
    try {
      candidates.push(await puppeteer.default.executablePath({ headless }));
    } catch {
      /* Browser has not been installed. */
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try another local browser. */
    }
  }
  return undefined;
}

export async function graphicsAvailable(): Promise<boolean> {
  try {
    await import("@hyperframes/producer");
    return !!(await browserPath());
  } catch {
    return false;
  }
}

export async function renderGraphic(options: GraphicOptions): Promise<void> {
  const html = graphicHtml(options);
  options.signal.throwIfAborted();
  const chromePath = await browserPath();
  if (!chromePath)
    throw new Error(
      "The local HyperFrames browser is not installed. Run npm run setup:visuals.",
    );
  const { createRenderJob, executeRenderJob, resolveConfig } = await import(
    "@hyperframes/producer"
  );
  const projectDir = path.join(
    path.resolve(options.workDir),
    `motion-card-${randomUUID()}`,
  );
  const output = path.resolve(options.output);
  await mkdir(projectDir, { recursive: true });
  await mkdir(path.dirname(output), { recursive: true });
  const renderSignal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(180_000),
  ]);
  try {
    // All source files are local and the template references no external assets.
    const require = createRequire(import.meta.url);
    for (const weight of [400, 700])
      await copyFile(
        require.resolve(
          `@fontsource/inter/files/inter-latin-${weight}-normal.woff2`,
        ),
        path.join(projectDir, `inter-${weight}.woff2`),
      );
    await writeFile(path.join(projectDir, "index.html"), html, "utf8");
    const job = createRenderJob({
      fps: 30,
      quality: "standard",
      format: "mp4",
      workers: 1,
      strictness: "strict",
      hdrMode: "force-sdr",
      crf: 20,
      producerConfig: resolveConfig({
        chromePath,
        enableBrowserPool: false,
        browserTimeout: 30_000,
        protocolTimeout: 30_000,
        concurrency: 1,
        disableGpu: true,
        browserGpuMode: "software",
        forceScreenshot: true,
        useDrawElement: false,
      }),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    await executeRenderJob(job, projectDir, output, undefined, renderSignal);
    renderSignal.throwIfAborted();
    if (job.status !== "complete" || (await stat(output)).size < 100)
      throw new Error("HyperFrames did not produce a complete motion card");
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    if (options.signal.aborted) options.signal.throwIfAborted();
    throw error;
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}
