import { spawn } from "node:child_process";
import { access, lstat, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { SocialImportError, socialCarouselLink } from "../shared/social-imports.js";
import { prepareCookies } from "./social-imports.js";

export const carouselImageName = /^\d{3}\.(?:jpg|jpeg|png|webp|avif)$/u;
export const MAX_CAROUSEL_IMAGES = 100;
export const MAX_CAROUSEL_BYTES = 512 * 1024 * 1024;
export interface CarouselImage { name: string; size: number }

async function downloader() {
  if (process.env.GALLERY_DL_BIN) return process.env.GALLERY_DL_BIN;
  for (const directory of [".venv-imports", ".venv"]) {
    const binary = path.resolve(directory, process.platform === "win32" ? "Scripts/gallery-dl.exe" : "bin/gallery-dl");
    try { await access(binary); return binary; } catch { /* Try the next installation. */ }
  }
  return "gallery-dl";
}

function downloadError(stderr: string, cookies: boolean) {
  if (/login|log in|sign in|authentication|private|challenge|checkpoint/iu.test(stderr))
    return new SocialImportError("The platform requires a login for this carousel. " + (cookies
      ? "Cookies were loaded but access was refused. Export fresh cookies.txt, then retry."
      : "Put your exported Netscape-format cookies.txt in the project or data folder, or set YT_DLP_COOKIES, then retry."));
  if (/429|rate.limit|too many requests/iu.test(stderr))
    return new SocialImportError("The platform is limiting carousel downloads. Wait a few minutes, then retry.");
  return new SocialImportError("The platform could not provide all carousel images. Check that the post opens in your browser, then retry. A login may be required; use exported cookies.txt. Update platform support with npm run setup:imports if public posts keep failing.");
}

/** Files retain the platform's slide numbers, original bytes and image format. */
export async function downloadSocialCarousel(input: string, directory: string, options: {
  signal: AbortSignal; maxBytes: number; checkSpace: () => Promise<void>;
  onProgress: (phase: string, percent: number) => void;
}): Promise<{ images: CarouselImage[]; name: string; size: number }> {
  const link = socialCarouselLink(input);
  options.signal.throwIfAborted();
  directory = await realpath(directory);
  const maxBytes = Math.min(options.maxBytes, MAX_CAROUSEL_BYTES);
  const binary = await downloader();
  const cookiePath = await prepareCookies(directory);
  try {
    options.signal.throwIfAborted();
    // --Print installs gallery-dl's built-in print postprocessor. Ignoring all
    // user configuration leaves only that fixed, non-executable progress hook.
    const args = ["--config-ignore", "--no-input", "--no-colors", "--no-mtime",
      "--cache-file", path.join(directory, "cache.sqlite3"), "--directory", directory,
      "--filename", "{num:03}.{extension}", "--retries", "2", "--http-timeout", "20",
      "--filesize-max", String(maxBytes), "--range", `1-${MAX_CAROUSEL_IMAGES + 1}`,
      "--whitelist", "instagram:post,tiktok:post,tiktok:vmpost",
      "--filter", "extension in ('jpg', 'jpeg', 'png', 'webp', 'avif')",
      "-o", "extractor.instagram.videos=false", "-o", "extractor.instagram.previews=false",
      "-o", "extractor.tiktok.video=false", "-o", "extractor.tiktok.audio=false", "-o", "extractor.tiktok.covers=false",
      "--Print", "prepare:remix-image:{num:03}.{extension}",
      ...(cookiePath ? ["--cookies", cookiePath] : []), "--", link.url];
    const expected = new Set<string>();
    await new Promise<void>((resolve, reject) => {
      const nodeScript = process.platform === "win32" && /\.[cm]?js$/iu.test(binary);
      const child = spawn(nodeScript ? process.execPath : binary, nodeScript ? [path.resolve(binary), ...args] : args,
        { cwd: directory, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "", pending = "", failure: Error | undefined, closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined, checking: Promise<void> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* Already exited. */ }
      };
      const stop = () => {
        if (closed || killTimer) return;
        kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 1000); killTimer.unref();
      };
      const fail = (error: Error) => { failure ??= error; stop(); };
      const line = (value: string) => {
        if (!value.startsWith("remix-image:")) return;
        const name = value.slice(12).trim();
        if (!carouselImageName.test(name) || expected.has(name)) {
          fail(new SocialImportError("The carousel returned invalid or duplicate slide numbers. Update platform support and retry.")); return;
        }
        expected.add(name);
        if (expected.size > MAX_CAROUSEL_IMAGES) fail(new SocialImportError(`A carousel can contain up to ${MAX_CAROUSEL_IMAGES} images.`));
        options.onProgress(`Downloading image ${expected.size} from ${link.platform}`, Math.min(80, expected.size));
      };
      child.stdout.on("data", chunk => {
        pending += chunk.toString();
        const lines = pending.split("\n"); pending = (lines.pop() || "").slice(-4096);
        for (const value of lines) line(value.trim());
      });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
      child.once("error", error => { failure = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? new SocialImportError("Carousel downloads need gallery-dl. Run npm run setup:imports, or run Video links setup in the desktop app, then retry.") : error; });
      const timeout = setTimeout(() => fail(new SocialImportError("The carousel download took too long. Retry the post.")), 10 * 60_000);
      const monitor = setInterval(() => {
        if (checking) return;
        checking = (async () => {
          await options.checkSpace();
          let bytes = 0;
          for (const entry of await readdir(directory)) {
            if (!/^\d{3}\./u.test(entry)) continue;
            const info = await lstat(path.join(directory, entry));
            if (info.isFile()) bytes += info.size;
          }
          if (bytes > maxBytes) throw new SocialImportError("This carousel exceeds the 512 MB download limit.");
        })().catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(error); }).finally(() => { checking = undefined; });
      }, 500);
      timeout.unref(); monitor.unref();
      options.signal.addEventListener("abort", stop, { once: true });
      if (options.signal.aborted) stop();
      child.once("close", async code => {
        closed = true; clearTimeout(timeout); clearInterval(monitor); clearTimeout(killTimer);
        options.signal.removeEventListener("abort", stop);
        await checking;
        try {
          options.signal.throwIfAborted(); line(pending.trim());
          if (failure) throw failure;
          if (code !== 0) throw downloadError(stderr, !!cookiePath);
          if (!expected.size) throw new SocialImportError("No carousel images were found. Use an Instagram image post or TikTok photo slideshow; video-only posts do not contain downloadable slides.");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    const images: CarouselImage[] = [];
    let size = 0;
    for (const name of [...expected].sort()) {
      options.signal.throwIfAborted();
      const file = path.join(directory, name), info = await lstat(file).catch(() => undefined);
      if (!info?.isFile() || info.size <= 0) throw new SocialImportError("Some carousel images were not downloaded. Retry to get the complete ZIP.");
      size += info.size;
      if (size > maxBytes) throw new SocialImportError("This carousel exceeds the 512 MB download limit.");
      const handle = await open(file, "r");
      try {
        const header = Buffer.alloc(32); await handle.read(header, 0, header.length, 0);
        const ext = path.extname(name);
        const valid = ext === ".jpg" || ext === ".jpeg" ? header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
          : ext === ".png" ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : ext === ".webp" ? header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP"
          : header.toString("ascii", 4, 8) === "ftyp" && /avif|avis/u.test(header.toString("ascii", 8));
        if (!valid) throw new SocialImportError("The platform returned an unreadable carousel image. Retry the post.");
      } finally { await handle.close(); }
      images.push({ name, size: info.size });
    }
    const postId = new URL(link.url).pathname.split("/").filter(Boolean).at(-1)!;
    return { images, name: `${link.platform.toLowerCase()}-${postId}-images.zip`, size };
  } finally { if (cookiePath) await rm(cookiePath, { force: true }); }
}
