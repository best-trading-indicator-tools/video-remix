import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiError, apiRequest, recordResponseProblems, streamError } from "../src/api-client.js";
import { clearDiagnostics, diagnosticReport, getDiagnostics, recordDiagnostic, reportProblem, setDiagnosticEnvironment } from "../src/diagnostics-store.js";
import { makeDiagnostic } from "../shared/diagnostics.js";

afterEach(() => { clearDiagnostics(); setDiagnosticEnvironment(undefined); });

test("network failures become actionable diagnostics without request contents", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(apiRequest("/api/imports/links?token=private", { method: "POST", body: "private input" }), error => {
    assert.ok(error instanceof ApiError); assert.equal(error.diagnostic.code, "ENGINE_UNREACHABLE");
    assert.doesNotMatch(diagnosticReport(error.diagnostic), /private/); return true;
  });
  assert.equal(getDiagnostics().length, 1);
});

test("server references survive API exceptions and repeat polling without duplicate reports", async t => {
  const diagnostic = makeDiagnostic("The linked original was moved or changed.", { operation: "Import video", requestId: "server-request" });
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: diagnostic.message, diagnostic }, { status: 409 }));
  for (let i = 0; i < 2; i++) await assert.rejects(apiRequest("/api/imports"), error => {
    assert.ok(error instanceof ApiError); assert.equal(error.diagnostic.id, diagnostic.id);
    reportProblem(error, { operation: "Another UI catch" }); return true;
  });
  assert.equal(getDiagnostics().length, 1);
});

test("partial successes remain successful while individual errors are retained", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ imports: [{ id: "ok" }], errors: [{ error: "EPERM: access denied" }] }, { status: 202 }));
  const body = await apiRequest<{ imports: { id: string }[] }>("/api/imports/links");
  assert.equal(body.imports[0].id, "ok"); assert.equal(getDiagnostics()[0].code, "FILE_ACCESS_DENIED");
  assert.doesNotThrow(() => recordResponseProblems({ errors: {} }, 200, "/api/test"));
});

test("intentional cancellation creates no warning or error", async t => {
  const controller = new AbortController(); controller.abort();
  t.mock.method(globalThis, "fetch", async () => { throw controller.signal.reason; });
  await assert.rejects(apiRequest("/api/previews", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(getDiagnostics().length, 0);
});

test("invalid JSON and empty successful responses explain version and connection checks", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>proxy failed</html>"));
  await assert.rejects(apiRequest("/api/health"), error => { assert.ok(error instanceof ApiError); assert.equal(error.diagnostic.code, "INVALID_RESPONSE"); return true; });
});

test("automatic workspace reads still reject network, proxy and malformed responses without retaining reports", async t => {
  let failure = "network";
  t.mock.method(globalThis, "fetch", async () => {
    if (failure === "network") throw new TypeError("Failed to fetch");
    if (failure === "proxy") return new Response("Bad gateway", { status: 502 });
    return new Response("<html>Server restarting</html>");
  });
  for (const endpoint of ["/api/health", "/api/auto/capabilities", "/api/sources", "/api/jobs", "/api/imports"]) {
    for (failure of ["network", "proxy", "invalid"]) {
      await assert.rejects(apiRequest(endpoint), error => {
        assert.ok(error instanceof ApiError);
        reportProblem(error, { operation: "Another UI catch" });
        return true;
      });
    }
  }
  assert.equal(getDiagnostics().length, 0);
});

test("quiet status reads do not suppress failed user actions or reads for individual resources", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  for (const [url, method] of [["/api/jobs", "POST"], ["/api/sources", "DELETE"], ["/api/imports", "POST"], ["/api/jobs/job-id/download", "GET"]]) {
    await assert.rejects(apiRequest(url!, { method }));
  }
  assert.equal(getDiagnostics().length, 4);
  assert.ok(getDiagnostics().every(issue => issue.code === "ENGINE_UNREACHABLE"));
});

test("repeated background reports stay quiet beyond the old one-minute deduplication window", () => {
  for (let i = 0; i < 5; i++) recordDiagnostic(makeDiagnostic("Request failed (502). Please try again.", {
    operation: "GET /api/jobs", occurredAt: new Date(Date.now() - i * 120000).toISOString(), httpStatus: 502,
  }));
  recordDiagnostic(makeDiagnostic("An invalid response was received", { operation: "Automatic capabilities", endpoint: "/api/auto/capabilities", method: "get" }));
  assert.equal(getDiagnostics().length, 0);
  clearDiagnostics();
  recordDiagnostic(makeDiagnostic("Request failed (502). Please try again.", { operation: "GET /api/jobs" }));
  assert.equal(getDiagnostics().length, 0);
});

test("streaming errors retain server references after HTTP headers have been sent", () => {
  const diagnostic = makeDiagnostic("The speech model is not ready.", { operation: "Transcribe video", requestId: "stream-request" });
  const error = streamError({ message: diagnostic.message, diagnostic }, "/api/shorts/transcript", "stream-request");
  assert.equal(error.diagnostic.id, diagnostic.id); assert.equal(getDiagnostics().length, 1);
});

test("history stays bounded and usable when browser storage is unavailable", () => {
  for (let i = 0; i < 35; i++) recordDiagnostic(makeDiagnostic(`Failure ${i}`, { operation: "Export video", entityId: `job-${i}` }));
  assert.equal(getDiagnostics().length, 30); assert.equal(getDiagnostics()[0].message, "Failure 34");
  assert.equal(getDiagnostics().at(-1)!.message, "Failure 5");
  clearDiagnostics(); assert.equal(getDiagnostics().length, 0);
});

test("a retry warning escalates to an error when the export finally fails", () => {
  const issue = makeDiagnostic("Rendering failed", { operation: "Export video", severity: "warning" });
  recordDiagnostic(issue); recordDiagnostic({ ...issue, severity: "error" });
  assert.equal(getDiagnostics().length, 1); assert.equal(getDiagnostics()[0].severity, "error");
});

 test("saved review reports do not become recent action failures", () => {
  clearDiagnostics();
  for (const operation of ["Editorial check", "Review finished picture", "Review finished audio"])
    recordDiagnostic(makeDiagnostic("A transcript of the selected speech is required", { operation, severity: "warning" }));
  assert.equal(getDiagnostics().length, 0);
  recordDiagnostic(makeDiagnostic("Server connection lost", { operation: "Review export" }));
  assert.equal(getDiagnostics().length, 1);
  clearDiagnostics();
});
