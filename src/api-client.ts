import { diagnosticEndpoint, diagnosticSchema, makeDiagnostic, type Diagnostic } from "../shared/diagnostics";
import { recordDiagnostic } from "./diagnostics-store";

export class ApiError extends Error {
  constructor(message: string, public diagnostic: Diagnostic) { super(message); this.name = "ApiError"; }
}
const endpointFor = diagnosticEndpoint;

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  try { return await fetch(url, init); }
  catch (error) {
    if (init?.signal?.aborted || (error as Error)?.name === "AbortError") throw error;
    const message = "Could not connect to the video engine. Check that the server is running.";
    const diagnostic = recordDiagnostic(makeDiagnostic(message, { operation: `${init?.method || "GET"} ${endpointFor(url)}`,
      endpoint: endpointFor(url), method: init?.method || "GET" }));
    throw new ApiError(message, diagnostic);
  }
}

export function recordResponseProblems(body: unknown, status: number, url: string, method = "GET", requestId?: string | null) {
  const data = body as { error?: string; diagnostic?: Diagnostic; errors?: { error: string; diagnostic?: Diagnostic }[] } | null;
  const record = (message: string, diagnostic?: Diagnostic) => recordDiagnostic(diagnosticSchema.safeParse(diagnostic).data || makeDiagnostic(message, {
    operation: `${method} ${endpointFor(url)}`, endpoint: endpointFor(url), method, httpStatus: status,
    ...(requestId ? { requestId } : {}),
  }));
  if (Array.isArray(data?.errors)) for (const item of data.errors) if (typeof item?.error === "string") record(item.error, item.diagnostic);
  return typeof data?.error === "string" ? record(data.error, data.diagnostic) : undefined;
}

export function streamError(event: { message: string; diagnostic?: Diagnostic }, url: string, requestId?: string | null): ApiError {
  const diagnostic = recordResponseProblems({ error: event.message, diagnostic: event.diagnostic }, 200, url, "POST", requestId)!;
  return new ApiError(diagnostic.message, diagnostic);
}

export async function responseError(response: Response, url: string, method = "GET"): Promise<ApiError> {
  const body = await response.json().catch(() => null);
  const message = typeof body?.error === "string" ? body.error : `Request failed (${response.status}). Please try again.`;
  const diagnostic = recordResponseProblems(body, response.status, url, method, response.headers.get("X-Request-ID")) ||
    recordDiagnostic(makeDiagnostic(message, { operation: `${method} ${endpointFor(url)}`, httpStatus: response.status,
      endpoint: endpointFor(url), method }));
  return new ApiError(diagnostic.message, diagnostic);
}

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  const body = await response.json().catch(() => null);
  // Never turn a cancelled response-body read into a successful null result.
  init?.signal?.throwIfAborted();
  const diagnostic = recordResponseProblems(body, response.status, url, init?.method, response.headers.get("X-Request-ID"));
  if (!response.ok || body === null) {
    const message = typeof body?.error === "string" ? body.error : (response.ok ? "The server returned an invalid response. Please refresh and try again." : `Request failed (${response.status}). Please try again.`);
    throw new ApiError(diagnostic?.message || message, diagnostic || recordDiagnostic(makeDiagnostic(message, {
      operation: `${init?.method || "GET"} ${endpointFor(url)}`, endpoint: endpointFor(url), method: init?.method || "GET", httpStatus: response.status,
    })));
  }
  return body as T;
}
