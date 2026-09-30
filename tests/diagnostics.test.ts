import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { diagnosticEndpoint, diagnosticSchema, explainProblem, makeDiagnostic, redactDiagnosticText, supportReport } from "../shared/diagnostics.js";
import { diagnosticMiddleware, serverDiagnostic } from "../server/diagnostics.js";

test("common failures explain the recovery action on Windows and other platforms", () => {
  for (const [message, status, code] of [
    ["The linked original was moved or changed. Import it again before exporting.", 409, "LINKED_SOURCE_UNAVAILABLE"],
    ["spawn ffprobe ENOENT", 500, "MEDIA_ENGINE_MISSING"],
    ["No such filter: subtitles", 500, "MEDIA_FEATURE_MISSING"],
    ["ENOSPC: write failed", 500, "DISK_FULL"],
    ["EPERM: operation not permitted", 500, "FILE_ACCESS_DENIED"],
    ["Transcripts need the local speech model", 422, "TRANSCRIPTION_NOT_READY"],
    ["Adding video links timed out after 30 seconds", undefined, "REQUEST_TIMEOUT"],
    ["Failed to fetch", undefined, "ENGINE_UNREACHABLE"],
    ["Invalid data found when processing input", 422, "MEDIA_UNREADABLE"],
    ["The browser could not play this video", undefined, "BROWSER_PLAYBACK_UNAVAILABLE"],
    ["Browser storage is unavailable", undefined, "BROWSER_STORAGE_UNAVAILABLE"],
  ] as const) {
    const issue = explainProblem(message, status);
    assert.equal(issue.code, code, message);
    assert.ok(issue.title.length && issue.nextStep.length);
  }
});

test("support reports redact local paths, credentials, emails and remote URLs", () => {
  const privateMessage = [
    String.raw`EPERM: C:\Users\Friend\Private client\film.mp4`,
    String.raw`Failed at \\office-server\private\video.mp4`,
    "input '/Users/person/Private client/film.mp4'",
    "input /home/friend/private-video.mp4",
    "input /srv/custom-person/video.mp4",
    "input //office-storage/private-folder/video.mp4",
    'api_key="secret-one" token=secret-two password: secret-three',
    "Authorization: Bearer secret-four",
    "provider sk-abcdefghijklmnop ghp_abcdefghijklmnop",
    "request https://example.com/video?token=secret-five for friend@example.com",
  ].join("\n");
  const diagnostic = makeDiagnostic(privateMessage, { operation: "Import video" });
  const report = supportReport(Object.assign(diagnostic, { body: "private transcript", environment: "private config" }), { "Client OS": "Windows" });
  for (const secret of ["Friend", "office-server", "office-storage", "custom-person", "Private client", "friend/private", "secret-one", "secret-two", "secret-three", "secret-four", "secret-five", "abcdefghijklmnop", "friend@example.com", "private transcript", "private config"]) assert.ok(!report.includes(secret), secret);
  assert.match(report, /EPERM/);
  assert.match(report, /Client OS: Windows/);
  assert.match(report, /Reference:/);
  assert.equal(diagnosticSchema.safeParse(diagnostic).success, true);
  assert.ok(redactDiagnosticText("a".repeat(5000)).length <= 1200);
});

test("API endpoint diagnostics omit query strings and arbitrary path values", () => {
  assert.equal(diagnosticEndpoint("/api/imports/8ca1e3fd-5076-4dcc-bb68-8452ce05779e?path=private"), "/api/imports/8ca1e3fd-5076-4dcc-bb68-8452ce05779e");
  assert.equal(diagnosticEndpoint("/api/imports/C%3A%5Cprivate.mp4"), "/api/imports/:value");
  assert.equal(diagnosticEndpoint("https://private.example/api/token"), "/api");
});

test("unexpected server exceptions omit private messages but retain safe code locations", () => {
  const error = Object.assign(new Error("private transcript: user dictated secret text"), { code: "CUSTOM_FAILURE" });
  error.stack = "Error: private text\n at run (C:\\Users\\Friend\\project\\server\\queue.ts:400:12)";
  const diagnostic = serverDiagnostic(error, { operation: "Export video", httpStatus: 500 });
  assert.equal(diagnostic.code, "SERVER_ERROR");
  assert.equal(diagnostic.systemCode, "CUSTOM_FAILURE");
  assert.deepEqual(diagnostic.frames, ["queue.ts:400:12"]);
  assert.doesNotMatch(supportReport(diagnostic), /private|Friend|dictated/);
});

test("API errors and partial batches keep HTTP behavior and receive correlated reports", async () => {
  const app = express(); app.use(diagnosticMiddleware); app.use(express.json());
  app.post("/api/imports", (req, res) => res.status(409).json({ error: "The linked original was moved or changed.", received: req.body }));
  app.get("/api/batch", (_req, res) => res.status(202).json({ imports: [{ id: "accepted" }], errors: [{ name: "video.mp4", error: "EPERM: access denied" }] }));
  app.get("/api/internal", (_req, res) => { res.locals.failure = new Error("private request payload"); res.status(500).json({ error: "Something went wrong." }); });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/api/imports?token=secret`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "private requested text" }) });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.diagnostic.id, response.headers.get("X-Request-ID"));
    assert.equal(body.diagnostic.code, "LINKED_SOURCE_UNAVAILABLE");
    assert.equal(body.diagnostic.endpoint, "/api/imports");
    assert.doesNotMatch(supportReport(body.diagnostic), /private requested text|secret/);
    assert.equal(diagnosticSchema.safeParse(body.diagnostic).success, true);
    const partial = await fetch(`${base}/api/batch`); const batch = await partial.json();
    assert.equal(partial.status, 202); assert.equal(batch.imports[0].id, "accepted");
    assert.equal(batch.errors[0].diagnostic.requestId, partial.headers.get("X-Request-ID"));
    assert.equal(batch.errors[0].diagnostic.code, "FILE_ACCESS_DENIED");
    const internal = await (await fetch(`${base}/api/internal`)).json();
    assert.doesNotMatch(JSON.stringify(internal.diagnostic), /private request payload/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
