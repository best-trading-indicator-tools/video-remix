import type { ImportSession } from "../shared/imports";

export { apiRequest as importRequest } from "./api-client";
import { apiRequest as importRequest } from "./api-client";
import { reportProblem } from "./diagnostics-store";
import { ApiError } from "./api-client";
import type { Diagnostic } from "../shared/diagnostics";

const preparationDeadline = 30_000;
const fileRecovery = "Check that the video is fully downloaded and opens on this computer. Try a copy in another local folder, then select it again.";

function preparationError(message: string, context: Partial<Diagnostic> & { operation: string }) {
  return new ApiError(message, reportProblem(new Error(message), context));
}

export const formatFileSize = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** Reject files the server would refuse, with a code that survives into copied reports. */
export function checkImportFile(file: File, maximum: number) {
  const operation = "Check video file for import";
  if (file.size <= 0) throw preparationError("This video file is empty (0 bytes). No upload was started for this file.", {
    operation, code: "EMPTY_VIDEO_FILE", title: "The selected video is empty", nextStep: fileRecovery,
  });
  if (file.size > maximum) throw preparationError(`This video is ${formatFileSize(file.size)}, above the ${formatFileSize(maximum)} import limit.`, {
    operation, code: "LIMIT_EXCEEDED", title: "This video exceeds the import limit",
    nextStep: "Trim or compress the video below the limit, or use Link files on this computer to use the original without uploading it.",
  });
  if (!/\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg)$/iu.test(file.name)) {
    const extension = /\.[\da-z]{1,10}$/iu.exec(file.name)?.[0].toLowerCase();
    throw preparationError(`${extension ? `${extension} files are` : "Files without an extension are"} not supported. Choose MP4, MOV, M4V, WebM, MKV, AVI or MPEG videos.`, {
      operation, code: "UNSUPPORTED_VIDEO_FORMAT", title: "This video format is not supported",
      nextStep: "Convert the video to MP4 (H.264 video, AAC audio), then select the converted copy.",
    });
  }
}

/** One failed file keeps its own diagnostic; several get a summary naming each file's code. */
export function preparationSummary(problems: { name: string; diagnostic: Diagnostic }[]): Diagnostic {
  if (problems.length === 1) return problems[0]!.diagnostic;
  const codes = new Set(problems.map(problem => problem.diagnostic.code));
  const shared = codes.size === 1 ? problems[0]!.diagnostic : undefined;
  const message = `${problems.length} videos could not be queued: ${problems.map(problem => `${problem.name} (${problem.diagnostic.code})`).join("; ")}. Files already queued can continue.`;
  return reportProblem(new Error(message), {
    operation: "Prepare video imports", code: shared?.code || "IMPORT_PREPARATION_FAILED", title: "Some videos could not be queued",
    nextStep: shared?.nextStep || "Each file's problem and fix is shown in the import panel. To send them all, open Help & errors and choose Copy recent error details.",
    ...(shared?.systemCode ? { systemCode: shared.systemCode } : {}),
  });
}

/** Bound the entire step, including a stalled browser read or response body. */
async function preparationStep<T>(work: (signal: AbortSignal) => Promise<T>, parent: AbortSignal | undefined,
  timeoutError: () => ApiError): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => controller.abort(timeoutError()), preparationDeadline);
  });
  try {
    return await Promise.race([work(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", stop);
  }
}

function readSample(blob: Blob, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  // Node regression fixtures use Blob; browsers use an explicitly abortable read.
  if (typeof FileReader === "undefined") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => {
      signal.removeEventListener("abort", cancel);
      reader.onload = reader.onerror = reader.onabort = null;
    };
    const cancel = () => { cleanup(); reader.abort(); reject(signal.reason); };
    reader.onload = () => { cleanup(); resolve(reader.result as ArrayBuffer); };
    reader.onerror = () => { const error = reader.error; cleanup(); reject(error || new Error("File read failed.")); };
    reader.onabort = () => { cleanup(); reject(new Error("The file read was interrupted.")); };
    signal.addEventListener("abort", cancel, { once: true });
    try { reader.readAsArrayBuffer(blob); }
    catch (error) { cleanup(); reject(error); }
  });
}

export function createUploadImport(file: File, identity: string, signal?: AbortSignal): Promise<ImportSession> {
  return preparationStep(stepSignal => importRequest<ImportSession>("/api/imports", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: stepSignal,
    body: JSON.stringify({ name: file.name, size: file.size, lastModified: file.lastModified, identity }),
  }), signal, () => preparationError("The server did not confirm this file import within 30 seconds. Preparation has stopped; the import may already be queued.", {
    operation: "Create file import", code: "IMPORT_QUEUE_TIMEOUT", title: "The server did not confirm the import",
    nextStep: "Check the app terminal and refresh the import queue before trying again. If this video is listed, select the same file to resume it. Copy these details if the server keeps failing to respond.",
    method: "POST", endpoint: "/api/imports",
  }));
}

export async function importVideoLinks(links: string[], download?: { stripMetadata: boolean }): Promise<{
  imports: ImportSession[]; errors?: { name: string; error: string }[];
}> {
  const controller = new AbortController();
  const endpoint = download ? "/api/downloads" : "/api/imports/links";
  // This deadline covers queue submission, including the response body, not the download.
  const timer = setTimeout(() => controller.abort(new Error(
    "Adding video links timed out after 30 seconds. Check that the app server is running and reachable. " +
    "The links may already be queued; refresh and check the import queue before submitting them again.",
  )), 30_000);
  try {
    return await importRequest(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ links, ...(download ? { stripMetadata: download.stripMetadata } : {}) }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) reportProblem(controller.signal.reason, { operation: download ? "Download video links" : "Import video links", endpoint, method: "POST" });
    controller.signal.throwIfAborted();
    throw error;
  } finally { clearTimeout(timer); }
}

// Read only two small samples. A 40 GB File is never materialized in browser memory.
export async function uploadIdentity(file: File, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!globalThis.crypto?.subtle) throw preparationError("This browser cannot check the file identity at the current app address.", {
    operation: "Read video file for import", code: "BROWSER_CRYPTO_UNAVAILABLE", title: "File import needs a secure browser connection",
    nextStep: "On the computer running the app, open http://localhost:5173 in a current browser. Remote access needs HTTPS. Then select the video again.",
  });
  try {
    return await preparationStep(async stepSignal => {
      const size = 64 * 1024;
      const first = new Uint8Array(await readSample(file.slice(0, size), stepSignal));
      stepSignal.throwIfAborted();
      const last = new Uint8Array(await readSample(file.slice(Math.max(size, file.size - size)), stepSignal));
      stepSignal.throwIfAborted();
      const bytes = new Uint8Array(first.length + last.length);
      bytes.set(first); bytes.set(last, first.length);
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      stepSignal.throwIfAborted();
      return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    }, signal, () => preparationError("The browser did not finish reading the selected video within 30 seconds. No upload was started for this file.", {
      operation: "Read video file for import", code: "FILE_READ_TIMEOUT", title: "Reading the video took too long", nextStep: fileRecovery,
    }));
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw preparationError("The browser could not read the selected video. No upload was started for this file.", {
      operation: "Read video file for import", code: "FILE_READ_FAILED", title: "The selected video could not be read", nextStep: fileRecovery,
      systemCode: error instanceof Error ? error.name.slice(0, 40) : undefined,
    });
  }
}

export async function transferImport(file: File, initial: ImportSession, signal: AbortSignal,
  onProgress: (session: ImportSession) => void): Promise<ImportSession> {
  let session = await importRequest<ImportSession>(`/api/imports/${initial.id}`, { signal });
  const validate = (value: ImportSession) => {
    if (value.id !== initial.id || value.size !== file.size || !Number.isSafeInteger(value.offset) ||
      value.offset < 0 || value.offset > file.size || !Number.isSafeInteger(value.chunkSize) ||
      value.chunkSize < 1 || value.chunkSize > 16 * 1024 * 1024)
      throw new Error("The server returned invalid upload details. Cancel this import and select the file again.");
  };
  validate(session);
  if (session.status !== "uploading") return session;
  while (session.offset < file.size) {
    signal.throwIfAborted();
    const offset = session.offset;
    const chunk = file.slice(offset, Math.min(file.size, offset + session.chunkSize));
    try {
      session = await importRequest<ImportSession>(`/api/imports/${session.id}`, {
        method: "PUT", headers: { "Content-Type": "application/octet-stream", "Upload-Offset": String(offset) },
        body: chunk, signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      // A response can be lost after the server committed a chunk. Trust its offset.
      const confirmed = await importRequest<ImportSession>(`/api/imports/${session.id}`, { signal });
      validate(confirmed);
      if (confirmed.offset <= offset) throw error;
      session = confirmed;
    }
    validate(session);
    if (session.offset <= offset)
      throw new Error("The server returned an invalid upload position. Pause and select the file again.");
    onProgress(session);
  }
  return importRequest<ImportSession>(`/api/imports/${session.id}/finish`, { method: "POST", signal });
}
