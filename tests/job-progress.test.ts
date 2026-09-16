import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JobProgress, { jobProgressLabel } from "../src/JobProgress.js";

test("review steps show elapsed work without a misleading percentage; rendering restores measured progress", t => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const startedAt = new Date(Date.now() - 42000).toISOString();
  for (const step of ["review", "propose", "verify"] as const) {
    const job = { progress: 65, editorialProgress: { startedAt, budgetMs: 120000, step, attempt: step === "review" ? 0 : 1 } };
    const html = renderToStaticMarkup(createElement(JobProgress, { job }));
    assert.match(html, /is-searching/u);
    assert.match(html, /0:42 elapsed/u);
    assert.match(html, /120-second limit/u);
    assert.doesNotMatch(html, /aria-valuenow|65%/u);
    assert.equal(jobProgressLabel(job), step === "propose" ? "Preparing correction" : "Checking edit");
    if (step !== "review") assert.match(html, /Correction 1 of 2/u);
  }
  const rendering = { progress: 78 };
  const html = renderToStaticMarkup(createElement(JobProgress, { job: rendering }));
  assert.match(html, /aria-valuenow="78"/u);
  assert.match(html, /width:78%/u);
  assert.doesNotMatch(html, /is-searching|DeepSeek|elapsed/u);
  assert.equal(jobProgressLabel(rendering), "78%");
});

test("stock preparation keeps its shot counts and bounded duration", () => {
  const job = { progress: 65, visualSearch: { startedAt: new Date().toISOString(), budgetMs: 480000, pass: 2, maxPasses: 3, requested: 4, placed: 2 } };
  const html = renderToStaticMarkup(createElement(JobProgress, { job }));
  assert.match(html, /2\/4 shots placed/u);
  assert.match(html, /8 minutes/u);
  assert.doesNotMatch(html, /aria-valuenow/u);
  assert.equal(jobProgressLabel(job), "Finding visuals");
});
