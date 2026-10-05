import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RequestHandler } from "express";
import { diagnosticEndpoint, explainProblem, makeDiagnostic, type Diagnostic, type RuntimeInfo } from "../shared/diagnostics.js";

export const runtimeInfo: RuntimeInfo = {
  appVersion: (() => { try { return String(JSON.parse(readFileSync("package.json", "utf8")).version); } catch { return "unknown"; } })(),
  revision: (() => { try { return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; } })(),
  platform: process.platform, node: process.versions.node,
};

export function serverDiagnostic(error: unknown, context: Partial<Diagnostic> & { operation: string }): Diagnostic {
  const value = error instanceof Error ? error : new Error(typeof error === "string" ? error : "An unexpected error occurred.");
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const frames = [...(value.stack || "").matchAll(/(?:server|shared)[\\/]([a-z\d_-]+\.[cm]?[jt]s):([\d]+):([\d]+)/giu)]
    .slice(0, 5).map(match => `${match[1]}:${match[2]}:${match[3]}`);
  const underlying = explainProblem(value.message, context.httpStatus);
  const explanation = context.message && ["ACTION_FAILED", "SERVER_ERROR"].includes(underlying.code)
    ? explainProblem(context.message, context.httpStatus) : underlying;
  // Unexpected internal failures may contain user content in upstream exceptions.
  const message = context.httpStatus === 500 ? (explanation.code === "SERVER_ERROR"
    ? "The server could not complete this action. Use the reference below to find the error in the app terminal."
    : explanation.title) : context.message ?? value.message;
  return makeDiagnostic(message, { ...explanation, ...context, server: runtimeInfo,
    ...(typeof code === "string" && /^[A-Z_\d]{2,40}$/u.test(code) ? { systemCode: code } : {}),
    ...(frames.length ? { frames } : {}),
  });
}

/** Enrich all JSON API error paths, including route-specific and batch errors. */
export const diagnosticMiddleware: RequestHandler = (req, res, next) => {
  if (!req.path.startsWith("/api")) { next(); return; }
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    const endpoint = diagnosticEndpoint(req.path);
    const context = { requestId, id: requestId, operation: `${req.method} ${endpoint}`, method: req.method,
      endpoint, httpStatus: res.statusCode };
    const issue = (message: string, index?: number) => serverDiagnostic(res.locals.failure || message,
      { ...context, ...(index === undefined ? {} : { id: `${requestId}-${index}` }) });
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const value = body as Record<string, unknown>;
      body = { ...value,
        ...(typeof value.error === "string" ? { diagnostic: value.diagnostic || issue(value.error) } : {}),
        ...(Array.isArray(value.errors) ? { errors: value.errors.map((item, index) => item && typeof item.error === "string"
          ? { ...item, diagnostic: issue(item.error, index) } : item) } : {}),
      };
    }
    return json(body);
  };
  next();
};
