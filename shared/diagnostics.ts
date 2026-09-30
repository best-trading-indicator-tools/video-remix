import { z } from "zod";

export interface RuntimeInfo { appVersion: string; revision: string; platform: string; node: string }
export interface Diagnostic {
  id: string;
  occurredAt: string;
  severity: "error" | "warning";
  code: string;
  title: string;
  nextStep: string;
  operation: string;
  message: string;
  requestId?: string;
  entityId?: string;
  httpStatus?: number;
  method?: string;
  endpoint?: string;
  systemCode?: string;
  frames?: string[];
  server?: RuntimeInfo;
}

export const diagnosticSchema = z.object({
  id: z.string().max(160), occurredAt: z.string().datetime(), severity: z.enum(["error", "warning"]),
  code: z.string().max(80), title: z.string().max(200), nextStep: z.string().max(1000),
  operation: z.string().max(400), message: z.string().max(1200), requestId: z.string().max(160).optional(),
  entityId: z.string().max(160).optional(), httpStatus: z.number().int().min(100).max(599).optional(),
  method: z.string().max(12).optional(), endpoint: z.string().max(400).optional(), systemCode: z.string().max(40).optional(),
  frames: z.array(z.string().max(160)).max(5).optional(),
  server: z.object({ appVersion: z.string().max(80), revision: z.string().max(80), platform: z.string().max(40), node: z.string().max(40) }).optional(),
});

export function diagnosticEndpoint(url: string): string {
  // Endpoint names and opaque IDs are useful; searches, paths, prompts and URLs are not.
  const pathname = url.split("?")[0]!;
  if (!pathname.startsWith("/api/")) return "/api";
  return pathname.split("/").map(part => /^[a-z][a-z-]{0,40}$/u.test(part) || /^[\da-f-]{36}$/iu.test(part) ? part : part ? ":value" : "").join("/").slice(0, 400);
}

/** Reports never include request bodies, environment variables, or file contents. */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\u001b\[[\d;]*m/gu, "")
    .replace(/\bBearer\s+[^\s"']+/giu, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu, "$1[redacted]")
    .replace(/\b(?:sk-|gh[pousr]_)[\w-]{8,}/gu, "[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/giu, "[url]")
    .replace(/\b[A-Z]:[\\/][^\r\n]*/giu, "[local path redacted]")
    .replace(/\\\\[^\r\n]*/gu, "[network path redacted]")
    .replace(/\/\/[^/\s]+\/[^\r\n]*/gu, "[network path redacted]")
    .replace(/\/(?:Users|home|private|tmp|var|Volumes|mnt|media|app|workspace|root|usr|opt|System|data)\/[^\r\n]*/gu, "[local path redacted]")
    .replace(/(^|[\s"'(:])\/(?!api(?:\/|\b))[^/\s][^\r\n]*/gu, "$1[local path redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu, "[email redacted]")
    .slice(0, 1200);
}

export function explainProblem(message: string, status?: number) {
  const rule = (code: string, title: string, nextStep: string) => ({ code, title, nextStep });
  if (/browser storage/iu.test(message))
    return rule("BROWSER_STORAGE_UNAVAILABLE", "Your edits could not be saved in this browser", "Keep this tab open to avoid losing edits. Allow site storage or free browser storage before continuing.");
  if (/browser cannot play|browser could not play/iu.test(message))
    return rule("BROWSER_PLAYBACK_UNAVAILABLE", "The browser could not play this video", "Check the connection and try a rendered preview. If the file plays outside the app, its format may not be supported by this browser; export can still work.");
  if (/linked original.*(?:moved|changed)|original file is missing/iu.test(message))
    return rule("LINKED_SOURCE_UNAVAILABLE", "The linked video could not be verified", "Use Browse files to import a copy. If you link the original again, keep it downloaded locally and in the same place until export finishes. Update the app if the file has not changed.");
  if (/ffmpeg|ffprobe/iu.test(message) && /install|not ready|not found|ENOENT|missing/iu.test(message))
    return rule("MEDIA_ENGINE_MISSING", "The video tools are not ready", "Install FFmpeg and ffprobe, check both commands work in the terminal that starts the app, then restart the app.");
  if (/no such filter|unknown encoder|encoder.*not found|filter.*not found/iu.test(message))
    return rule("MEDIA_FEATURE_MISSING", "This FFmpeg installation is missing a required feature", "Install an FFmpeg build with libx264, AAC, drawtext and subtitles support, then restart the app and retry.");
  if (/ENOSPC|EDQUOT|not enough.*(?:space|disk)|disk.*full/iu.test(message) || status === 507)
    return rule("DISK_FULL", "There is not enough disk space", "Free space on the drive used by the app, then resume the upload or retry the export.");
  if (/EACCES|EPERM|permission|Windows could not create a link/iu.test(message))
    return rule("FILE_ACCESS_DENIED", "The app cannot access this file or folder", "Use Browse files to import a local copy. Check that the app can read the video and write to its workspace, then retry.");
  if (/speech model|setup:auto|faster.whisper|transcription.*unavailable|Python.*(?:install|missing|not found)/iu.test(message))
    return rule("TRANSCRIPTION_NOT_READY", "Speech transcription is not ready", "Install Python 3.10–3.13 and run npm run setup:auto in the project folder, then restart the app. You can still edit timestamps manually.");
  if (/yt-dlp|setup:imports/iu.test(message))
    return rule("LINK_IMPORTER_NOT_READY", "The video-link importer needs attention", "Run npm run setup:imports in the project folder, then retry. Browse files can import a downloaded video instead.");
  if (/timed out|timeout|took too long|time limit/iu.test(message) || status === 408 || status === 504)
    return rule("REQUEST_TIMEOUT", "The operation took too long", "Check the connection and the import/export queue before trying again: the server may already have accepted the operation. For processing, try a shorter clip.");
  if (/failed to fetch|network.?error|network request|server is running|connection.*(?:lost|engine)|could not connect|upload interrupted/iu.test(message))
    return rule("ENGINE_UNREACHABLE", "The app cannot reach the video engine", "Check that the app terminal is still running, then wait for it to reconnect. Check the queue before resubmitting an import or export.");
  if (status === 429 || /rate.limit|too many requests/iu.test(message))
    return rule("SERVICE_BUSY", "The service is temporarily limiting requests", "Wait a few minutes before retrying. Avoid repeatedly pressing the same action.");
  if (/api.?key|unauthorized|authentication|credentials/iu.test(message) || status === 401)
    return rule("SERVICE_AUTH_REQUIRED", "An external service is not configured correctly", "Check the service configuration on the computer running the app, then restart it. Never send your API keys with an error report.");
  if (/too large|exceeds.*(?:size|limit)|maximum.*file size/iu.test(message) || status === 413)
    return rule("LIMIT_EXCEEDED", "This file or request exceeds the limit", "Choose a smaller file or batch, or shorten the requested edit, then try again.");
  if (/invalid.*(?:video|media)|readable video|playable video|invalid data|does not contain.*video/iu.test(message))
    return rule("MEDIA_UNREADABLE", "The video could not be read", "Check that the original plays outside the app. Try a complete local MP4 copy, then import it again.");
  if (/no longer available|not found|ENOENT|missing.*file/iu.test(message) || status === 404)
    return rule("RESOURCE_UNAVAILABLE", "The requested file or item is unavailable", "Refresh the workspace. If the original was moved, removed or expired, import it again before continuing.");
  if (/ffmpeg failed|ffprobe failed|rendering failed/iu.test(message))
    return rule("MEDIA_PROCESSING_FAILED", "The video could not be processed", "Try a short preview with basic settings. If it fails again, copy the error details and send them to the app owner.");
  if (/unexpected.*(?:response|json)|response.*(?:incomplete|invalid)|invalid.*response/iu.test(message))
    return rule("INVALID_RESPONSE", "The app received an incomplete response", "Check that both the frontend and server are running the same app version, then refresh. Check the queue before submitting the operation again.");
  return rule(status && status >= 500 ? "SERVER_ERROR" : "ACTION_FAILED", "This action could not be completed", "Check the message below and correct any highlighted settings. If the problem persists, copy the error details and send them to the app owner.");
}

export function makeDiagnostic(message: string, context: Partial<Diagnostic> & { operation: string }): Diagnostic {
  const explanation = explainProblem(message, context.httpStatus);
  return {
    ...explanation, ...context,
    id: context.id || globalThis.crypto.randomUUID(),
    occurredAt: context.occurredAt || new Date().toISOString(),
    severity: context.severity || "error",
    message: redactDiagnosticText(message),
    operation: redactDiagnosticText(context.operation),
  };
}

export function supportReport(issue: Diagnostic, client: Record<string, string> = {}): string {
  // Explicit fields only: no accidental spreading of API bodies, settings or secrets.
  return ["Video Remixer — support report", `Reference: ${issue.id}`, `When: ${issue.occurredAt}`,
    `Severity: ${issue.severity}`, `Code: ${issue.code}`, `Action: ${issue.operation}`,
    `Summary: ${issue.title}`, `Message: ${redactDiagnosticText(issue.message)}`, `Next step: ${issue.nextStep}`,
    issue.requestId && `Request: ${issue.requestId}`, issue.entityId && `Import/export: ${issue.entityId}`,
    issue.httpStatus && `HTTP: ${issue.httpStatus}`, issue.endpoint && `Endpoint: ${issue.method || "GET"} ${issue.endpoint}`,
    issue.systemCode && `System code: ${issue.systemCode}`, issue.frames?.length && `Code locations: ${issue.frames.join(", ")}`,
    issue.server && `Server: ${issue.server.platform}; Node ${issue.server.node}; app ${issue.server.appVersion}; revision ${issue.server.revision}`,
    ...Object.entries(client).map(([key, value]) => `${key}: ${redactDiagnosticText(value)}`),
    "Review messages before sharing. No files, request bodies or environment variables are attached.",
  ].filter(Boolean).map(line => redactDiagnosticText(String(line))).join("\n");
}
