import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type EditPlan, type ExportHistoryEntry, type ExportReview, type PostMetrics } from "../shared/types.js";
import { correctionRecord, measurementSummary, measurementsCsv, measurementsSchema } from "../server/measurements.js";

const firstTime = "2026-09-01T09:00:00.000Z";
const lastTime = "2026-09-01T10:00:00.000Z";
const entry = (id: string, overrides: Partial<ExportHistoryEntry> = {}): ExportHistoryEntry => ({
  id, jobId: id, sourceId: `source-${id}`, sourceFingerprint: "a".repeat(64), sourceName: "Source.mp4", title: "A useful idea",
  cuts: [{ start: 0, end: 10 }], sourceText: "Source speech", outputDuration: 10, createdAt: firstTime,
  revision: 1, stockShots: [], publications: [], ...overrides,
});
const plan = (): EditPlan => ({
  version: 1, revision: 1, sourceId: "source", sourceDuration: 20, outputDuration: 10, createdAt: firstTime,
  settings: { ...DEFAULT_SETTINGS }, cuts: [{ start: 0, end: 10 }], narration: false,
  captions: [
    { id: "a", start: 0, end: 1, text: "First sentence" },
    { id: "b", start: 1, end: 2, text: "Second sentence" },
    { id: "c", start: 2, end: 3, text: "Third sentence" },
  ],
  media: [
    { id: "clip-a", name: "Clip A", kind: "broll", duration: 5 },
    { id: "clip-b", name: "Clip B", kind: "broll", duration: 5 },
    { id: "card", name: "Card", kind: "graphic", duration: 3 },
  ],
  visuals: [
    { id: "shot", mediaId: "clip-a", start: 4, end: 6, sourceStart: 1, enabled: true, locked: true },
    { id: "graphic", mediaId: "card", start: 7, end: 9, sourceStart: 0, enabled: true, locked: true },
  ],
});

test("measurement documents enforce bounded counts, complete review pairs, plain text and valid observation dates", () => {
  assert.deepEqual(measurementsSchema.parse({}), {});
  assert.deepEqual(measurementsSchema.parse({ review: { approach: "  Examples  ", brollReviewed: 0, brollAccepted: 0, correctionSeconds: 0 } }),
    { review: { approach: "Examples", brollReviewed: 0, brollAccepted: 0, correctionSeconds: 0 } });
  assert.ok(measurementsSchema.safeParse({ posts: [{ platform: "instagram", measuredAt: lastTime,
    views: 0, averageWatchSeconds: 0, completionPercent: 100, saves: 0, shares: 0 }] }).success);
  for (const invalid of [
    { review: { brollReviewed: 3 } }, { review: { brollAccepted: 1 } },
    { review: { brollReviewed: 2, brollAccepted: 3 } },
    { review: { openingClear: 1 } }, { review: { endingComplete: "yes" } },
    { review: { captionCorrections: 1.5 } }, { review: { captionCorrections: -1 } },
    { review: { correctionSeconds: Infinity } }, { review: { correctionSeconds: 86401 } },
    { review: { correctionSeconds: NaN } }, { review: { captionCorrections: null } },
    { review: { approach: "a".repeat(81) } }, { review: { benchmarkCase: "a".repeat(81) } },
    { review: { notes: "a".repeat(501) } }, { review: { notes: "bad\u0000text" } },
    { review: { originalityScore: 99 } }, { path: "/tmp/private" },
    { posts: [{ platform: "youtube", measuredAt: lastTime }] },
    { posts: [{ platform: "instagram", measuredAt: "yesterday" }] },
    { posts: [{ platform: "instagram", measuredAt: lastTime, views: -1 }] },
    { posts: [{ platform: "instagram", measuredAt: lastTime, views: 1.5 }] },
    { posts: [{ platform: "instagram", measuredAt: lastTime, views: 1e13 }] },
    { posts: [{ platform: "instagram", measuredAt: lastTime, completionPercent: 101 }] },
    { posts: [{ platform: "instagram", measuredAt: lastTime, averageWatchSeconds: -1 }] },
    { posts: [{ platform: "instagram", measuredAt: lastTime, platformNotice: "a".repeat(501) }] },
    { posts: [{ platform: "instagram", measuredAt: lastTime, revenue: 1 }] },
    { posts: Array.from({ length: 21 }, () => ({ platform: "tiktok", measuredAt: lastTime })) },
  ]) assert.equal(measurementsSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test("whole-short verdicts and issue reasons are optional, bounded and validated", () => {
  for (const verdict of ["accepted-unchanged", "accepted-after-correction", "rejected"] as const) {
    assert.deepEqual(measurementsSchema.parse({ review: { verdict } }), { review: { verdict } });
  }
  const reasons = ["opening", "ending", "meaning", "hook", "captions", "framing", "broll", "other"];
  assert.deepEqual(measurementsSchema.parse({ review: { verdict: "rejected", issueReasons: reasons } }),
    { review: { verdict: "rejected", issueReasons: reasons } });
  assert.deepEqual(measurementsSchema.parse({ review: { issueReasons: [] } }), { review: { issueReasons: [] } });
  for (const review of [
    { verdict: "accepted" }, { verdict: "" }, { verdict: null }, { verdict: true }, { verdict: ["rejected"] },
    { issueReasons: "meaning" }, { issueReasons: null }, { issueReasons: ["unknown"] }, { issueReasons: [null] },
    { issueReasons: ["opening", "opening"] }, { issueReasons: [...reasons, "other"] },
  ]) assert.equal(measurementsSchema.safeParse({ review }).success, false, JSON.stringify(review));
});

test("acceptance rates use explicit whole-short verdicts, including rejections, and never infer acceptance", () => {
  const entries = [
    entry("unchanged", { measurements: { review: { verdict: "accepted-unchanged", approach: "A" } } }),
    entry("corrected", { revision: 2, measurements: { review: { verdict: "accepted-after-correction", approach: "A", issueReasons: ["captions"] } } }),
    entry("rejected", { measurements: { review: { verdict: "rejected", approach: "A", issueReasons: ["meaning", "ending"] } } }),
    entry("legacy-positive", { measurements: { review: { openingClear: true, endingComplete: true, brollReviewed: 2, brollAccepted: 2 } } }),
    entry("automatic", { corrections: { captionCorrections: 0, brollChanges: 0, seconds: 0 } }),
    entry("issues-only", { measurements: { review: { issueReasons: ["hook"] } } }),
    entry("blank"),
    entry("malformed-legacy", { measurements: { review: { verdict: "approved", issueReasons: null } as unknown as ExportReview } }),
  ];
  const original = structuredClone(entries);
  const summary = measurementSummary(entries);
  assert.equal(summary.totals.verdictReviews, 3);
  assert.equal(summary.totals.unknownAcceptanceExports, 5);
  assert.equal(summary.totals.acceptedUnchanged, 1);
  assert.equal(summary.totals.acceptedAfterCorrection, 1);
  assert.equal(summary.totals.rejected, 1);
  assert.equal(summary.totals.acceptanceRate, 2 / 3);
  assert.equal(summary.totals.unchangedAcceptanceRate, 1 / 3);
  assert.equal(summary.totals.reviewedExports, 5);
  const group = summary.groups.find(item => item.approach === "A")!;
  assert.equal(group.verdictReviews, 3);
  assert.equal(group.unknownAcceptanceExports, 0);
  assert.equal(group.acceptanceRate, 2 / 3);
  const unknown = summary.groups.find(item => item.approach === null)!;
  assert.equal(unknown.acceptanceRate, null);
  assert.equal(unknown.unchangedAcceptanceRate, null);
  const rejectedOnly = measurementSummary([entries[2]!]).totals;
  assert.equal(rejectedOnly.acceptanceRate, 0);
  assert.equal(rejectedOnly.unchangedAcceptanceRate, 0);
  assert.equal(measurementSummary([]).totals.acceptanceRate, null);
  assert.equal(measurementSummary([]).totals.unknownAcceptanceExports, 0);
  assert.deepEqual(entries, original);
});

test("median correction time includes measured zero and manual overrides but excludes unknowns", () => {
  const measured = [
    entry("zero", { measurements: { review: { verdict: "accepted-unchanged", correctionSeconds: 0 } } }),
    entry("override", { corrections: { captionCorrections: 0, brollChanges: 0, seconds: 500 }, measurements: { review: { correctionSeconds: 10 } } }),
    entry("saved", { corrections: { captionCorrections: 0, brollChanges: 0, seconds: 100 } }),
    entry("unchanged-unknown", { measurements: { review: { verdict: "accepted-unchanged" } } }),
    entry("unknown"),
  ];
  const stats = measurementSummary(measured).totals;
  assert.equal(stats.correctionTimeExports, 3);
  assert.equal(stats.medianCorrectionSeconds, 10);
  assert.equal(stats.averageCorrectionSeconds, 110 / 3);
  assert.equal(measurementSummary(measured.slice(0, 2)).totals.medianCorrectionSeconds, 5);
  assert.equal(measurementSummary(measured.slice(3)).totals.medianCorrectionSeconds, null);
  assert.equal(measurementSummary([]).totals.medianCorrectionSeconds, null);
});

test("correction records count content edits and shot changes once while preserving both plans", () => {
  const before = plan();
  const original = structuredClone(before);
  const after = structuredClone(before);
  after.captions[0]!.text = "Corrected first sentence";
  after.captions.splice(1, 1);
  after.captions.push({ id: "new", start: 3, end: 4, text: "Added sentence" });
  after.captions[1]!.start += 0.5;
  after.captions[1]!.end += 0.5;
  after.visuals[0] = { ...after.visuals[0]!, mediaId: "clip-b", start: 4.5, end: 6.5, sourceStart: 2, focalPoint: { x: 0.8, y: 0.5 }, locked: false };
  after.visuals[1]!.enabled = false;
  after.visuals.push({ id: "added-shot", mediaId: "clip-a", start: 8, end: 10, sourceStart: 0, enabled: true, locked: true });
  const afterCopy = structuredClone(after);
  assert.deepEqual(correctionRecord(before, after, 12.5), { captionCorrections: 3, brollChanges: 2, seconds: 12.5 });
  assert.deepEqual(before, original);
  assert.deepEqual(after, afterCopy);
  const removedShot = structuredClone(before);
  removedShot.visuals.splice(0, 1);
  assert.equal(correctionRecord(before, removedShot).brollChanges, 1);
  const disabledShot = structuredClone(before);
  disabledShot.visuals[0]!.enabled = false;
  assert.equal(correctionRecord(before, disabledShot).brollChanges, 1);
});

test("timing-only captions, regenerated IDs, equivalent focal defaults and lock toggles are not content corrections", () => {
  const before = plan();
  const after = structuredClone(before);
  after.captions = after.captions.map(cue => ({ ...cue, id: `retimed-${cue.id}`, start: cue.start + 1, end: cue.end + 1 }));
  after.visuals[0]!.locked = false;
  after.visuals[0]!.reason = "Updated explanation";
  after.visuals[0]!.focalPoint = { x: 0.5, y: 0.5 };
  assert.deepEqual(correctionRecord(before, after), { captionCorrections: 0, brollChanges: 0 });
  assert.equal(correctionRecord(before, after, 0).seconds, 0);
  assert.equal(correctionRecord(before, after, 86400).seconds, 86400);
  for (const invalid of [-1, 86400.1, Infinity, NaN]) assert.throws(() => correctionRecord(before, after, invalid));
  const duplicates = structuredClone(before);
  duplicates.captions = [{ id: "one", start: 0, end: 1, text: "Same" }, { id: "two", start: 1, end: 2, text: "Same" }];
  const single = structuredClone(duplicates);
  single.captions = [{ id: "new", start: 0, end: 1, text: "Same" }];
  assert.equal(correctionRecord(duplicates, single).captionCorrections, 1, "Matching identical text must respect how many captions exist");
});

function measuredEntries(): ExportHistoryEntry[] {
  return [
    entry("a", { corrections: { captionCorrections: 3, brollChanges: 2, seconds: 120 }, measurements: {
      review: { approach: "Narration", benchmarkCase: "Work", openingClear: true, endingComplete: false,
        brollReviewed: 3, brollAccepted: 2, captionCorrections: 1, correctionSeconds: 60 },
      posts: [
        { platform: "instagram", measuredAt: firstTime, views: 9999, averageWatchSeconds: 999, completionPercent: 99, saves: 999, platformNotice: "Old notice" },
        { platform: "tiktok", measuredAt: lastTime, views: 100, averageWatchSeconds: 30, completionPercent: 80, saves: 2, platformNotice: "Limited recommendation" },
        { platform: "instagram", measuredAt: lastTime, views: 300, averageWatchSeconds: 20, completionPercent: 60, saves: 6, shares: 3, platformNotice: "" },
      ],
    } }),
    entry("b", { corrections: { captionCorrections: 5, brollChanges: 1, seconds: 30 }, measurements: {
      review: { approach: "Narration", benchmarkCase: "Work", openingClear: false, endingComplete: true,
        brollReviewed: 1, brollAccepted: 1, captionCorrections: 0, correctionSeconds: 0 },
      posts: [{ platform: "instagram", measuredAt: lastTime, views: 100, averageWatchSeconds: 10, completionPercent: 20, saves: 0, shares: 1 }],
    } }),
    entry("c", { measurements: { review: { approach: "Demo", benchmarkCase: "Work", openingClear: true }, posts: [
      { platform: "tiktok", measuredAt: lastTime, views: 1000, saves: 1000 },
      { platform: "tiktok", measuredAt: lastTime, views: 0, averageWatchSeconds: 999, completionPercent: 100, saves: 1, shares: 0 },
    ] } }),
    entry("unreviewed"),
  ];
}

test("summary math uses reviewed denominators and explicit manual overrides, including zero", () => {
  const entries = measuredEntries();
  const original = structuredClone(entries);
  const summary = measurementSummary(entries);
  const totals = summary.totals;
  assert.equal(totals.exports, 4);
  assert.equal(totals.reviewedExports, 3);
  assert.equal(totals.openingReviews, 3);
  assert.equal(totals.openingClearRate, 2 / 3);
  assert.equal(totals.endingReviews, 2);
  assert.equal(totals.endingCompleteRate, 0.5);
  assert.equal(totals.brollReviewExports, 2);
  assert.equal(totals.brollReviewed, 4);
  assert.equal(totals.brollAccepted, 3);
  assert.equal(totals.brollAcceptanceRate, 0.75);
  assert.equal(totals.captionMeasuredExports, 2);
  assert.equal(totals.captionCorrections, 1);
  assert.equal(totals.averageCaptionCorrections, 0.5);
  assert.equal(totals.brollChangedExports, 2);
  assert.equal(totals.brollChanges, 3);
  assert.equal(totals.correctionTimeExports, 2);
  assert.equal(totals.correctionSeconds, 60);
  assert.equal(totals.averageCorrectionSeconds, 30);
  assert.equal(summary.groups.length, 3);
  const narration = summary.groups.find(group => group.approach === "Narration")!;
  assert.equal(narration.benchmarkCase, "Work");
  assert.equal(narration.exports, 2);
  assert.equal(narration.openingClearRate, 0.5);
  const empty = summary.groups.find(group => group.approach === null)!;
  assert.equal(empty.openingClearRate, null);
  assert.equal(empty.averageCaptionCorrections, null);
  assert.equal(empty.averageCorrectionSeconds, null);
  assert.deepEqual(entries, original);
});

test("only latest per-platform observations contribute and platform distributions stay separate", () => {
  const summary = measurementSummary(measuredEntries());
  const totals = summary.totals;
  assert.equal(totals.posts, 4);
  assert.equal(totals.totalViews, 500);
  assert.equal(totals.postsWithWatchTime, 4);
  assert.equal(totals.watchTimeViews, 500);
  assert.equal(totals.averageWatchSeconds, 20);
  assert.equal(totals.completionViews, 500);
  assert.equal(totals.completionPercent, 56);
  assert.equal(totals.totalSaves, 9);
  assert.equal(totals.postsWithSaves, 4);
  assert.equal(totals.totalShares, 4);
  assert.equal(totals.postsWithShares, 3);
  assert.equal(totals.platformNotices, 1);
  const instagram = totals.platforms.find(platform => platform.platform === "instagram")!;
  const tiktok = totals.platforms.find(platform => platform.platform === "tiktok")!;
  assert.equal(instagram.posts, 2);
  assert.equal(instagram.totalViews, 400);
  assert.equal(instagram.averageWatchSeconds, 17.5);
  assert.equal(instagram.completionPercent, 50);
  assert.equal(tiktok.posts, 2);
  assert.equal(tiktok.totalViews, 100);
  assert.equal(tiktok.averageWatchSeconds, 30);
  assert.equal(tiktok.completionPercent, 80);
  assert.equal(tiktok.platformNotices, 1);
  assert.equal(summary.groups.find(group => group.approach === "Demo")!.platforms.find(platform => platform.platform === "tiktok")!.averageWatchSeconds, null,
    "A zero-view observation cannot supply a views-weighted average");
});

test("missing and legacy null metrics remain unknown and new snapshots do not borrow old measurements", () => {
  const missing = entry("missing", { measurements: { review: { approach: "Approach only", benchmarkCase: "Case only" }, posts: [
    { platform: "instagram", measuredAt: lastTime, averageWatchSeconds: 18, saves: null, shares: null },
    { platform: "tiktok", measuredAt: lastTime, views: null, averageWatchSeconds: null, completionPercent: 70 },
  ] as unknown as PostMetrics[] } });
  const stats = measurementSummary([missing, entry("blank", { measurements: { review: {} } })]).totals;
  assert.equal(stats.reviewedExports, 0);
  assert.equal(stats.posts, 2);
  assert.equal(stats.totalViews, null);
  assert.equal(stats.averageWatchSeconds, null);
  assert.equal(stats.postsWithWatchTime, 1);
  assert.equal(stats.completionPercent, null);
  assert.equal(stats.postsWithCompletion, 1);
  assert.equal(stats.totalSaves, null);
  assert.equal(stats.totalShares, null);
  const reset = entry("newer", { measurements: { posts: [
    { platform: "instagram", measuredAt: firstTime, views: 10, averageWatchSeconds: 12, saves: 4 },
    { platform: "instagram", measuredAt: lastTime, views: 20 },
  ] } });
  const latest = measurementSummary([reset]).totals;
  assert.equal(latest.totalViews, 20);
  assert.equal(latest.averageWatchSeconds, null);
  assert.equal(latest.totalSaves, null);
  const fallback = entry("automatic", { corrections: { captionCorrections: 2, brollChanges: 0, seconds: 30 }, measurements: { review: { approach: "Automatic" } } });
  const automatic = measurementSummary([fallback]).totals;
  assert.equal(automatic.captionCorrections, 2);
  assert.equal(automatic.averageCorrectionSeconds, 30);
  assert.equal(automatic.reviewedExports, 0);
  const empty = measurementSummary([]);
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.totals.exports, 0);
  assert.equal(empty.totals.totalViews, null);
  assert.equal(empty.totals.brollAcceptanceRate, null);
});

test("approach and benchmark case form independent grouping keys", () => {
  const summary = measurementSummary([
    entry("one", { measurements: { review: { approach: "A|B", benchmarkCase: "C" } } }),
    entry("two", { measurements: { review: { approach: "A", benchmarkCase: "B|C" } } }),
    entry("three", { measurements: { review: { approach: "A|B", benchmarkCase: "Different" } } }),
  ]);
  assert.equal(summary.groups.length, 3);
  assert.ok(summary.groups.every(group => group.exports === 1));
});

function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const character = csv[i]!;
    if (character === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) { row.push(cell); cell = ""; }
    else if (character === "\r" && csv[i + 1] === "\n" && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ""; i++;
    } else cell += character;
  }
  assert.equal(quoted, false, "All CSV fields must close their quotes");
  assert.equal(cell, "");
  assert.deepEqual(row, []);
  return rows;
}

test("CSV preserves quoted multiline text, exports latest observations, and prevents spreadsheet formulas", () => {
  const entries = measuredEntries();
  entries[0]!.sourceName = '=HYPERLINK("https://example.org","Source")';
  entries[0]!.title = 'A "quoted", useful title\nwith another line';
  entries[0]!.measurements!.review!.approach = " +SUM(1,2)";
  entries[0]!.measurements!.review!.benchmarkCase = "@test";
  entries[0]!.measurements!.review!.notes = "\t=1+1";
  entries[0]!.measurements!.posts![1]!.platformNotice = "-1+2";
  const original = structuredClone(entries);
  const csv = measurementsCsv(entries);
  const rows = csvRows(csv);
  assert.equal(rows.length, 6, "Four latest platform observations and one unposted export plus headers");
  const [header, ...data] = rows;
  const column = (name: string) => header!.indexOf(name);
  assert.ok(data.every(row => row.length === header!.length));
  const first = data.filter(row => row[column("history_id")] === "a");
  assert.equal(first.length, 2);
  for (const row of first) {
    assert.equal(row[column("source_name")], `'${entries[0]!.sourceName}`);
    assert.equal(row[column("title")], entries[0]!.title);
    assert.equal(row[column("approach")], "'+SUM(1,2)");
    assert.equal(row[column("benchmark_case")], "'@test");
    assert.equal(row[column("caption_corrections")], "1");
    assert.equal(row[column("correction_seconds")], "60");
    assert.equal(row[column("review_notes")], "'\t=1+1");
  }
  assert.equal(first.find(row => row[column("platform")] === "instagram")![column("views")], "300");
  assert.equal(first.find(row => row[column("platform")] === "tiktok")![column("platform_notice")], "'-1+2");
  const zero = data.find(row => row[column("history_id")] === "b")!;
  assert.equal(zero[column("caption_corrections")], "0");
  assert.equal(zero[column("correction_seconds")], "0");
  const unreviewed = data.find(row => row[column("history_id")] === "unreviewed")!;
  assert.equal(unreviewed[column("views")], "");
  assert.equal(unreviewed[column("caption_corrections")], "");
  assert.equal(unreviewed[column("correction_seconds")], "");
  assert.ok(!csv.includes("Old notice"));
  assert.equal(csvRows(measurementsCsv([])).length, 1);
  assert.deepEqual(entries, original);
});

test("CSV exports verdicts and structured reasons while leaving legacy and malformed decisions blank", () => {
  const entries = [
    entry("unchanged", { measurements: { review: { verdict: "accepted-unchanged" } } }),
    entry("corrected", { measurements: { review: { verdict: "accepted-after-correction", issueReasons: ["captions", "framing"] } } }),
    entry("rejected", { measurements: { review: { verdict: "rejected", issueReasons: ["meaning", "ending"] } } }),
    entry("legacy", { measurements: { review: { openingClear: true } } }),
    entry("malformed", { measurements: { review: { verdict: "=1+1", issueReasons: "meaning" } as unknown as ExportReview } }),
  ];
  const [header, ...rows] = csvRows(measurementsCsv(entries));
  const column = (name: string) => header!.indexOf(name);
  assert.ok(column("verdict") >= 0 && column("issue_reasons") >= 0);
  assert.ok(rows.every(row => row.length === header!.length));
  assert.equal(rows[0]![column("verdict")], "accepted-unchanged");
  assert.equal(rows[0]![column("correction_seconds")], "", "Acceptance does not invent a zero correction time");
  assert.equal(rows[1]![column("verdict")], "accepted-after-correction");
  assert.equal(rows[1]![column("issue_reasons")], "captions;framing");
  assert.equal(rows[2]![column("verdict")], "rejected");
  assert.equal(rows[2]![column("issue_reasons")], "meaning;ending");
  for (const row of rows.slice(3)) {
    assert.equal(row[column("verdict")], "");
    assert.equal(row[column("issue_reasons")], "");
  }
});
