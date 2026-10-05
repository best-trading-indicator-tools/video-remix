import { diagnosticSchema, makeDiagnostic, redactDiagnosticText, supportReport, type Diagnostic, type RuntimeInfo } from "../shared/diagnostics";

const STORAGE = "remix-support-events-v1";
const savedReviewOperations = new Set(["Editorial check", "Review finished picture", "Review finished audio"]);
// These GETs refresh workspace state automatically. Their failures belong to the
// current connection status, not a permanent list of failed user actions.
const backgroundReads = new Set(["/api/health", "/api/auto/capabilities", "/api/sources", "/api/jobs", "/api/imports"]);
const oldStartupMessages = new Set([
  "Could not connect to the video engine. Check that the server is running.",
  "Your video library could not be loaded. Refresh to try again.",
]);
function retainDiagnostic(issue: Diagnostic): boolean {
  if (savedReviewOperations.has(issue.operation)) return false;
  const request = /^(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\S+)$/iu.exec(issue.operation);
  const method = (issue.method || request?.[1] || "").toUpperCase();
  const endpoint = (issue.endpoint || request?.[2] || "").split("?")[0]!.replace(/\/$/u, "");
  if (method === "GET" && backgroundReads.has(endpoint)) return false;
  // Older builds also registered their startup toast and connection banner.
  if (issue.operation === "Connect to video engine" && issue.code === "ENGINE_UNREACHABLE") return false;
  if (issue.operation === "Workspace action" && oldStartupMessages.has(issue.message)) return false;
  return true;
}
const listeners = new Set<() => void>();
let server: RuntimeInfo | undefined;
let tools: string | undefined;
let issues: Diagnostic[] = [];
try {
  const saved = JSON.parse(sessionStorage.getItem(STORAGE) || "[]");
  if (Array.isArray(saved)) {
    issues = saved.flatMap(item => { const parsed = diagnosticSchema.safeParse(item); return parsed.success && retainDiagnostic(parsed.data) ? [parsed.data] : []; }).slice(0, 30);
    if (issues.length !== saved.length) sessionStorage.setItem(STORAGE, JSON.stringify(issues));
  }
} catch { /* Diagnostics remain available in memory when storage is blocked. */ }
const empty: Diagnostic[] = [];
export const subscribeDiagnostics = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getDiagnostics = () => issues;
export const getServerDiagnostics = () => empty;
function publish() {
  try { sessionStorage.setItem(STORAGE, JSON.stringify(issues)); } catch { /* In-memory fallback. */ }
  listeners.forEach(listener => listener());
}
export function setDiagnosticEnvironment(runtime?: RuntimeInfo, capabilities?: { ffmpeg: boolean; ffprobe: boolean }) {
  server = runtime;
  if (capabilities) tools = `FFmpeg ${capabilities.ffmpeg ? "ready" : "missing"}; ffprobe ${capabilities.ffprobe ? "ready" : "missing"}`;
}
export function recordDiagnostic(issue: Diagnostic): Diagnostic {
  if (!retainDiagnostic(issue)) return issue;
  const existing = issues.find(item => item.id === issue.id || (item.code === issue.code && item.operation === issue.operation &&
    item.entityId === issue.entityId && item.message === issue.message && Date.now() - Date.parse(item.occurredAt) < 60_000));
  if (existing) {
    if (existing.severity === "warning" && issue.severity === "error") {
      const updated = { ...existing, severity: issue.severity };
      issues = issues.map(item => item === existing ? updated : item); publish(); return updated;
    }
    return existing;
  }
  const value = { ...issue, server: issue.server || server };
  issues = [value, ...issues].slice(0, 30); publish(); return value;
}
export function findDiagnostic(message: string) {
  return issues.find(item => item.message === redactDiagnosticText(message));
}
export function reportProblem(error: unknown, context: Partial<Diagnostic> & { operation: string }): Diagnostic {
  const message = error instanceof Error ? error.message : String(error || "An unexpected error occurred.");
  const carried = diagnosticSchema.safeParse((error as { diagnostic?: unknown } | null)?.diagnostic);
  return recordDiagnostic(carried.success ? carried.data : makeDiagnostic(message, context));
}
export function clearDiagnostics() { issues = []; publish(); }
export function clientEnvironment() {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Edg\/([\d.]+)/u.exec(ua) || /Firefox\/([\d.]+)/u.exec(ua) || /Chrome\/([\d.]+)/u.exec(ua) || /Version\/([\d.]+)/u.exec(ua);
  return {
    "Client OS": /Windows/iu.test(ua) ? "Windows" : /Macintosh|Mac OS X/iu.test(ua) ? "macOS / iOS" : /Android/iu.test(ua) ? "Android" : /Linux/iu.test(ua) ? "Linux" : "unknown",
    Browser: browser?.[0] || "unknown",
    "Frontend revision": typeof __APP_REVISION__ === "string" ? __APP_REVISION__ : "unknown",
    ...(tools ? { "Video tools": tools } : {}),
  };
}
export const diagnosticReport = (issue: Diagnostic) => supportReport(issue, clientEnvironment());

export function installRuntimeDiagnostics() {
  window.addEventListener("error", event => {
    if (event.error) reportProblem(event.error, { operation: "Application runtime" });
  });
  window.addEventListener("unhandledrejection", event => {
    if (event.reason?.name !== "AbortError") reportProblem(event.reason, { operation: "Background operation" });
  });
}
