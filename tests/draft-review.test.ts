import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { approveShortDraft, createShortDraft, restoreShortDrafts, shortIsApproved, type ShortDraft } from "../shared/shorts.js";
import { DEFAULT_SETTINGS, type EditPlan, type ExportHistoryEntry, type VideoSource } from "../shared/types.js";
import { reviewShotTarget } from "../shared/review-actions.js";
import { draftHistoryMatches } from "../server/draft-history.js";
import { batchSchema } from "../server/schema.js";
import { installClipDiscoveryRoutes } from "../server/clip-discovery-routes.js";
import { state, type StoredSource } from "../server/store.js";
import { applyEditPlanChanges } from "../server/edit-plan.js";
import type { FinishedIssue } from "../shared/finished-review.js";

const source: VideoSource = { id: "1dc97e51-b59d-446e-b4ae-1b1d9f7d32e1", name: "Source.mp4", fingerprint: "a".repeat(64), size: 1000, duration: 60,
  width: 1920, height: 1080, fps: 30, hasAudio: true, createdAt: "2026-09-17T12:00:00.000Z", url: "/source", thumbnailUrl: "/thumb" };
const own = { id: "aacaa565-781a-440c-b0bf-8b76f167e0c8", assetId: "3f4509be-8c84-4cec-aa7c-0af38bd794d9", mode: "insert" as const,
  at: 3, start: 0, end: 2, audio: "mute" as const, fit: "contain" as const };
const draft = () => ({ ...createShortDraft(source, "draft", "cut"), review: { summary: "A complete idea", contribution: "My example" } });
const entry = (patch: Partial<ExportHistoryEntry> = {}): ExportHistoryEntry => ({ id: "export", jobId: "job", sourceId: "earlier-import", sourceFingerprint: source.fingerprint!,
  sourceName: source.name, title: "Earlier export", cuts: [{ start: 0, end: 10 }], sourceText: "Private transcript", outputDuration: 10,
  createdAt: source.createdAt, revision: 1, stockShots: [], publications: [], ...patch });
const plan = (): EditPlan => ({ version: 1, revision: 1, sourceId: source.id, sourceDuration: 60, outputDuration: 20, createdAt: source.createdAt,
  settings: { ...DEFAULT_SETTINGS, segments: [{ start: 10, end: 20 }, { start: 30, end: 40 }], ownFootage: [own] },
  cuts: [{ start: 10, end: 20 }, { start: 30, end: 40 }], captions: [], narration: false,
  visuals: [{ id: "shot", mediaId: "media", start: 6, end: 8, sourceStart: 0, enabled: true, locked: true }],
  media: [{ id: "media", name: "Saved shot", kind: "broll", duration: 5 }] });
const issue = (start: number, end = start + 0.1): FinishedIssue => ({ check: "misleading-illustration", start, end, message: "Check shot", evidence: "Evidence" });

test("approval survives storage and derived focus analysis, but every content edit invalidates it", () => {
  const approved = approveShortDraft({ ...draft(), ownFootage: [{ ...own, appendToEnd: true }] });
  assert.ok(shortIsApproved(approved));
  const restored = restoreShortDrafts(JSON.parse(JSON.stringify({ version: 1, drafts: [approved] })))[0];
  assert.ok(shortIsApproved(restored));
  assert.ok(shortIsApproved({ ...approved, updatedAt: "later", cuts: approved.cuts.map(cut => ({ ...cut, focusTrack: [{ time: 1, x: 0.2, y: 0.4 }] })) }));
  for (const patch of [ { title: "Changed" }, { id: "copy" }, { sourceId: "reimport" }, { zoom: 1.5 }, { normalizeAudio: true },
    { cuts: [{ ...approved.cuts[0], end: "15" }] }, { ownFootage: [] }, { review: { ...approved.review, contribution: "Different angle" } },
  ] satisfies Partial<ShortDraft>[]) assert.equal(shortIsApproved({ ...approved, ...patch }), false, JSON.stringify(patch));
  assert.equal(shortIsApproved(restoreShortDrafts({ version: 1, drafts: [draft()] })[0]), false);
  assert.equal(restoreShortDrafts({ version: 1, drafts: [{ ...approved, review: { ...approved.review, approvedAt: "invalid" } }] })[0].review?.approvedAt, undefined);
});

test("approved render requests preserve the exact settings and reject random variants or unbounded notes", () => {
  const body = { items: [{ sourceId: source.id, title: "Idea", settings: DEFAULT_SETTINGS,
    draftReview: { summary: "Idea", contribution: "", approvedAt: source.createdAt } }], variants: 1, randomize: false };
  assert.ok(batchSchema.safeParse(body).success);
  assert.equal(batchSchema.safeParse({ ...body, variants: 2 }).success, false);
  assert.equal(batchSchema.safeParse({ ...body, randomize: true }).success, false);
  assert.equal(batchSchema.safeParse({ ...body, items: [{ ...body.items[0], draftReview: { ...body.items[0].draftReview, summary: "x".repeat(601) } }] }).success, false);
});

test("history overlap merges repeated intervals, distinguishes publications, and bounds its result", () => {
  const unpublished = entry({ cuts: [{ start: 0, end: 9 }, { start: 5, end: 10 }] });
  const published = entry({ id: "published", cuts: [{ start: 5, end: 12 }], publications: [{ platform: "tiktok", publishedAt: source.createdAt }] });
  const result = draftHistoryMatches([{ start: 0, end: 10 }, { start: 5, end: 15 }], [unpublished, published]);
  assert.equal(result.matches[0].id, "published");
  assert.equal(result.matches[1].overlapSeconds, 10);
  assert.equal(result.matches[1].draftCoverage, 10 / 15);
  assert.equal(result.matches[1].publications.length, 0);
  assert.equal(draftHistoryMatches([{ start: 10, end: 20 }], [unpublished]).total, 0);
  const many = draftHistoryMatches([{ start: 0, end: 5 }], Array.from({ length: 9 }, (_, i) => entry({ id: String(i) })));
  assert.equal(many.matches.length, 5); assert.equal(many.total, 9);
  assert.ok(!JSON.stringify(result).includes("Private transcript"));
});

test("review lookup uses source fingerprints across reimports without rendering or discovery", async () => {
  const sources = state.sources, history = state.history, jobs = structuredClone(state.jobs);
  state.sources = [{ ...source } as StoredSource, { ...source, id: own.id, fingerprint: undefined } as StoredSource];
  state.history = [entry(), entry({ id: "unrelated", sourceFingerprint: "b".repeat(64) })];
  const app = express(); app.use(express.json());
  installClipDiscoveryRoutes(app, { transcript: async () => { throw new Error("Must not transcribe"); }, discover: async () => { throw new Error("Must not discover"); } });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const post = (body: unknown) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shorts/review-history`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const item = { id: "draft", sourceId: source.id, cuts: [{ start: 1, end: 5 }] };
  try {
    const response = await post({ drafts: [item, { ...item, id: "unknown", sourceId: own.assetId }, { ...item, id: "legacy", sourceId: own.id }] });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const result = (await response.json()).drafts;
    assert.equal(result[0].matches.length, 1); assert.equal(result[0].matches[0].id, "export");
    assert.equal(result[1].status, "source-unavailable"); assert.equal(result[2].status, "identity-unavailable");
    for (const body of [{ drafts: [item, item] }, { drafts: [{ ...item, cuts: [{ start: 0, end: 61 }] }] },
      { drafts: [{ ...item, cuts: [{ start: 4, end: 1 }] }] }, { drafts: [{ ...item, filePath: "/private" }] },
      { drafts: Array.from({ length: 101 }, (_, i) => ({ ...item, id: String(i) })) }]) assert.equal((await post(body)).status, 400);
    assert.deepEqual(state.jobs, jobs);
  } finally { state.sources = sources; state.history = history; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("finding actions map the rendered clock across cuts, speed, inserts and split visual windows", () => {
  const value = plan();
  assert.deepEqual(reviewShotTarget(value, issue(8.2), 30), { kind: "visual", id: "shot" });
  assert.equal(reviewShotTarget(value, issue(6.2), 30), undefined);
  assert.deepEqual(reviewShotTarget(value, issue(3.2), 30), { kind: "footage", id: own.id });
  assert.equal(reviewShotTarget(value, issue(8.2)), undefined, "Unknown source frame rate cannot guess insert timing");
  value.settings.speed = 2;
  assert.deepEqual(reviewShotTarget(value, issue(8.2), 30), { kind: "visual", id: "shot" });
  value.visuals[0].start = 2; value.visuals[0].end = 6;
  assert.deepEqual(reviewShotTarget(value, issue(5.2), 30), { kind: "visual", id: "shot" });
  assert.equal(reviewShotTarget(value, issue(2.5, 5.5), 30), undefined, "Do not guess across an insert");
  assert.deepEqual(reviewShotTarget(value, issue(5, 5), 30), { kind: "visual", id: "shot" });
});

test("ambiguous overlaps, caption findings and changed/disabled shots do not imply a removal", () => {
  const value = plan();
  assert.equal(reviewShotTarget(value, { ...issue(8.2), check: "caption-speech" }, 30), undefined);
  assert.equal(reviewShotTarget(value, issue(10, 10), 30), undefined, "A shot end is not inside that shot");
  value.settings.ownFootage!.push({ ...own, id: "cover", mode: "cover", at: 6 });
  assert.equal(reviewShotTarget(value, issue(8.2), 30), undefined);
  value.visuals[0].enabled = false;
  assert.deepEqual(reviewShotTarget(value, issue(8.2), 30), { kind: "footage", id: "cover" });
});

test("a user-requested removal creates a revision without mutating the original plan or captions", () => {
  const original = plan();
  const target = reviewShotTarget(original, issue(8.2), 30)!;
  const next = applyEditPlanChanges(original, { revision: original.revision, visuals: original.visuals.map(item => item.id === target.id ? { ...item, enabled: false } : item) });
  assert.equal(next.visuals[0].enabled, false); assert.equal(original.visuals[0].enabled, true);
  assert.deepEqual(next.captions, original.captions); assert.deepEqual(next.cuts, original.cuts);
});
