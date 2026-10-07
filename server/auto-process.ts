import { spawn } from "node:child_process";
export async function runLocal(
  binary: string,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number; cwd?: string; onStdout?: (chunk: string) => void; processGroup?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted)
    throw new DOMException("Cancelled", "AbortError");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      detached: options.processGroup && process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      expired = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (options.processGroup && child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
      } else if (options.processGroup && child.pid && process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => child.kill(signal));
      } else child.kill(signal);
    };
    const abort = () => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      expired = true;
      abort();
    }, options.timeout ?? 120000);
    timer.unref();
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-2_000_000);
      options.onStdout?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-300_000);
    });
    child.once("error", (error) => {
      clear();
      reject(error);
    });
    child.once("close", (code) => {
      if (options.processGroup && (options.signal?.aborted || expired)) kill("SIGKILL");
      clear();
      if (options.signal?.aborted)
        return reject(new DOMException("Cancelled", "AbortError"));
      if (expired)
        return reject(
          new Error(`${binary} took too long. Try a shorter video.`),
        );
      if (code !== 0)
        return reject(
          new Error(
            `${binary}: ${stderr.trim().slice(-1500) || `exit ${code}`}`,
          ),
        );
      resolve({ stdout, stderr });
    });
  });
}
export const MEDIA_INPUT_ARGS = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,avi,mpeg,mpegts,flv,ogg,asf,wav,mp3,flac,aac,aiff,nut",
];
