import type { ImportSession } from "../shared/imports";

export { apiRequest as importRequest } from "./api-client";
import { apiRequest as importRequest } from "./api-client";
import { reportProblem } from "./diagnostics-store";

export async function importVideoLinks(links: string[]): Promise<{
  imports: ImportSession[]; errors?: { name: string; error: string }[];
}> {
  const controller = new AbortController();
  // This deadline covers queue submission, including the response body, not the download.
  const timer = setTimeout(() => controller.abort(new Error(
    "Adding video links timed out after 30 seconds. Check that the app server is running and reachable. " +
    "The links may already be queued; refresh and check the import queue before submitting them again.",
  )), 30_000);
  try {
    return await importRequest("/api/imports/links", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ links }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) reportProblem(controller.signal.reason, { operation: "Import video links", endpoint: "/api/imports/links", method: "POST" });
    controller.signal.throwIfAborted();
    throw error;
  } finally { clearTimeout(timer); }
}

// Read only two small samples. A 40 GB File is never materialized in browser memory.
export async function uploadIdentity(file: File): Promise<string> {
  const size = 64 * 1024;
  const first = new Uint8Array(await file.slice(0, size).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(size, file.size - size)).arrayBuffer());
  const bytes = new Uint8Array(first.length + last.length);
  bytes.set(first);
  bytes.set(last, first.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
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
