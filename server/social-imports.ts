import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SocialImportError, socialVideoLink } from "../shared/social-imports.js";

async function downloader() {
  if (process.env.YT_DLP_BIN) return process.env.YT_DLP_BIN;
  for (const directory of [".venv-imports", ".venv"]) {
    const binary = path.resolve(directory, process.platform === "win32" ? "Scripts/yt-dlp.exe" : "bin/yt-dlp");
    try { await access(binary); return binary; } catch { /* Try the next installation. */ }
  }
  return "yt-dlp";
}

async function prepareCookies(directory: string): Promise<string | undefined> {
  const configured = process.env.YT_DLP_COOKIES?.trim();
  if (!configured) return undefined;
  let contents: string;
  try {
    const file = await open(path.resolve(configured), "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0 || info.size > 10 * 1024 * 1024) throw new Error("Invalid cookie file");
      contents = (await file.readFile("utf8")).replace(/^\uFEFF/u, "");
    } finally { await file.close(); }
  } catch {
    throw new SocialImportError("The configured download cookies could not be read. Check YT_DLP_COOKIES in .env points to a readable cookies file, or remove that setting to import public videos without cookies.");
  }
  if (!/^#(?: Netscape)? HTTP Cookie File(?:\r?\n|$)/u.test(contents))
    throw new SocialImportError("The configured download cookies must be a Netscape-format cookies.txt file. Export it again and check YT_DLP_COOKIES in .env.");
  // yt-dlp writes its cookie jar back on exit. Each download gets a private
  // copy so concurrent imports cannot overwrite each other or the user's file.
  const file = path.join(directory, `cookies-${randomUUID()}.txt`);
  await writeFile(file, contents, { mode: 0o600, flag: "wx" });
  return file;
}

function downloadError(stderr: string) {
  if (/max.filesize|larger than|File is larger|does not pass filter/iu.test(stderr))
    return new SocialImportError("This video exceeds the import limit, is still live, or is longer than 24 hours. Choose a shorter, completed video.");
  if (/private video|(?:login|authentication)\s+(?:is\s+)?required|requir(?:e[sd]?|ing)\s+(?:a\s+)?(?:login|authentication)|log in|sign in|age.restrict|confirm.{0,30}not a bot/iu.test(stderr))
    return new SocialImportError("The platform requires a login or age verification for this download. Configure YT_DLP_COOKIES in .env with your exported cookies file, use a public video, or import a local copy with Browse files.");
  if (/does not look like a Netscape|failed to load cookies|invalid.*cookies? file/iu.test(stderr))
    return new SocialImportError("The configured download cookies could not be loaded. Export a fresh Netscape-format cookies.txt file and check YT_DLP_COOKIES in .env.");
  if (/HTTP Error 429|too many requests|rate.limit/iu.test(stderr))
    return new SocialImportError("The platform is limiting downloads right now. Wait a few minutes, then use Retry import.");
  if (/HTTP Error 403|403 Forbidden|HTTP Error 5\d\d|timed out|timeout|connection reset|temporar(?:y|ily)/iu.test(stderr))
    return new SocialImportError("The video server refused or interrupted the download. This can be temporary; use Retry import to request a fresh download. If it keeps failing, use Browse files to import a local copy.");
  if (/video (?:is )?(?:unavailable|not available)|removed|not available in your country/iu.test(stderr))
    return new SocialImportError("This video is unavailable or restricted in this region. Check that the link still plays in your browser, or import a local copy with Browse files.");
  return new SocialImportError("The platform could not provide this video. Use Retry import to try again, or import a local copy with Browse files. If public links keep failing, update the importer with npm run setup:imports.");
}

export async function downloadSocialVideo(input: string, directory: string, options: {
  signal: AbortSignal; maxBytes: number;
  onProgress: (phase: string, percent: number) => void;
  checkSpace: () => Promise<void>;
}): Promise<{ file: string; name: string; size: number }> {
  const link = socialVideoLink(input);
  options.signal.throwIfAborted();
  directory = await realpath(directory);
  // Only built-in extractors for the three supported platforms. Never load a
  // user's yt-dlp configuration, plugins, browser cookies or executable postprocessors.
  const args = ["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--playlist-items", "1",
    "--use-extractors", "youtube,tiktok,vm.tiktok,instagram", "--no-cache-dir", "--no-colors", "--newline",
    "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2", "--abort-on-unavailable-fragments",
    "--js-runtimes", `node:${process.execPath}`, "--no-simulate", "--progress", "--progress-delta", "0.5",
    "--max-filesize", String(options.maxBytes), "--match-filters", "!is_live & !is_upcoming & duration <=? 86400",
    "--format", "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    "--merge-output-format", "mp4", "--remux-video", "mp4",
    "--output", "video.%(ext)s",
    "--progress-template", 'download:remix-progress:{"downloaded":%(progress.downloaded_bytes)j,"total":%(progress.total_bytes)j,"estimate":%(progress.total_bytes_estimate)j}',
    "--print", 'after_move:remix-result:{"file":%(filepath)j,"title":%(title)j}', "--", link.url];
  const binary = await downloader();
  options.signal.throwIfAborted();
  const cookiePath = await prepareCookies(directory);
  if (cookiePath) args.splice(args.indexOf("--"), 0, "--cookies", cookiePath);
  return new Promise<{ file: string; name: string; size: number }>((resolve, reject) => {
    options.signal.throwIfAborted();
    // Script fixtures and explicitly configured JS wrappers need Node on Windows;
    // executable yt-dlp installations continue to launch directly, without a shell.
    const nodeScript = process.platform === "win32" && /\.[cm]?js$/iu.test(binary);
    const child = spawn(nodeScript ? process.execPath : binary, nodeScript ? [path.resolve(binary), ...args] : args,
      { cwd: directory, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", pending = "", pendingError = "", result: { file?: unknown; title?: unknown } | undefined;
    let failure: Error | undefined, monitoring = false, closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Already exited. */ }
    };
    const stop = () => {
      if (killTimer || closed) return;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const fail = (error: Error) => { failure ??= error; stop(); };
    const line = (value: string) => {
      try {
        if (value.startsWith("remix-result:")) result = JSON.parse(value.slice(13));
        if (value.startsWith("remix-progress:")) {
          const progress = JSON.parse(value.slice(15));
          const bytes = Number(progress.downloaded) || 0;
          const total = Number(progress.total) || Number(progress.estimate) || 0;
          if (bytes > options.maxBytes || total > options.maxBytes)
            fail(new SocialImportError("This video exceeds the maximum import file size. Choose a smaller video."));
          options.onProgress(`Downloading from ${link.platform}`, total > 0 ? Math.min(70, Math.round(bytes / total * 70)) : 0);
        }
      } catch { /* Ignore non-protocol output from the downloader. */ }
    };
    child.stdout.on("data", chunk => {
      pending += chunk.toString();
      const lines = pending.split("\n"); pending = (lines.pop() || "").slice(-16000);
      for (const value of lines) line(value.trim());
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-16000);
      pendingError += chunk.toString();
      const lines = pendingError.split("\n"); pendingError = (lines.pop() || "").slice(-16000);
      for (const value of lines) line(value.trim());
    });
    const timeout = setTimeout(() => fail(new SocialImportError("The download took too long. Try again or use Browse files to import a local copy.")), 45 * 60_000);
    const monitor = setInterval(() => {
      if (monitoring) return;
      monitoring = true;
      void (async () => {
        await options.checkSpace();
        let bytes = 0;
        for (const entry of await readdir(directory)) {
          if (!entry.startsWith("video.")) continue;
          const info = await lstat(path.join(directory, entry));
          if (info.isFile()) bytes += info.size;
        }
        // Muxing briefly needs both the downloaded streams and the final file.
        if (bytes > options.maxBytes * 2) throw new SocialImportError("This video exceeds the maximum import file size. Choose a smaller video.");
      })().catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(error); }).finally(() => { monitoring = false; });
    }, 2000);
    timeout.unref(); monitor.unref();
    const clear = () => {
      clearTimeout(timeout); clearInterval(monitor); clearTimeout(killTimer);
      options.signal.removeEventListener("abort", stop);
    };
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    child.once("error", error => {
      failure = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? new SocialImportError("Link importing needs yt-dlp. Run npm run setup:imports in the project folder, then retry.") : error;
    });
    child.once("close", async code => {
      closed = true;
      clear();
      try {
        options.signal.throwIfAborted();
        line(pending.trim()); line(pendingError.trim());
        if (failure) throw failure;
        if (code !== 0) throw downloadError(stderr);
        if (!result || typeof result.file !== "string") throw downloadError(stderr);
        const file = path.resolve(directory, result.file);
        if (file !== path.join(directory, "video.mp4")) throw new SocialImportError("The downloaded video could not be prepared as an MP4. Import a local copy instead.");
        const info = await lstat(file);
        if (!info.isFile() || info.size <= 0 || info.size > options.maxBytes)
          throw new SocialImportError("The downloaded video is empty or exceeds the maximum import file size.");
        const title = typeof result.title === "string" ? result.title.replace(/[\u0000-\u001f\u007f/\\]/gu, "").trim().slice(0, 170) : "";
        resolve({ file, name: `${title || `${link.platform} video`}.mp4`, size: info.size });
      } catch (error) { reject(error); }
    });
  }).finally(async () => { if (cookiePath) await rm(cookiePath, { force: true }); });
}
