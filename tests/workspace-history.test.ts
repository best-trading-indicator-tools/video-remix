import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceHistory } from "../shared/workspace-history.js";
test("one batch action restores multiple videos, defaults and preset library together", () => {
  const history = new WorkspaceHistory();
  history.init("videos", { a: 1, b: 2 }); history.init("default", 1); history.init("presets", [] as string[]);
  history.label("Apply preset to all videos");
  history.set("videos", { a: 3, b: 3 }, "Settings"); history.set("default", 3, "Defaults"); history.set("presets", ["Warm"], "Presets");
  history.undo();
  assert.deepEqual(history.get("videos"), { a: 1, b: 2 }); assert.equal(history.get("default"), 1); assert.deepEqual(history.get("presets"), []);
  assert.equal(history.undoLabel, undefined); assert.equal(history.redoLabel, "Apply preset to all videos");
  history.redo(); assert.deepEqual(history.get("videos"), { a: 3, b: 3 }); assert.equal(history.get("default"), 3);
});
test("a long slider gesture is one step, separate clicks remain separate, branching drops redo", () => {
  const history = new WorkspaceHistory(); history.init("zoom", 1); history.group = {};
  for (let n = 2; n <= 50; n++) { history.set("zoom", n, "Zoom"); history.flush(); }
  history.group = undefined; history.set("zoom", 75, "Zoom"); history.flush();
  history.undo(); assert.equal(history.get("zoom"), 50); history.undo(); assert.equal(history.get("zoom"), 1);
  history.redo(); history.set("zoom", 25, "Zoom"); history.flush(); assert.equal(history.redoLabel, undefined);
});
test("imports survive earlier Undo and deleted media cannot return through Undo or Redo", () => {
  const history = new WorkspaceHistory(); history.init("videos", { a: 1 } as Record<string, number>);
  history.set("videos", { a: 2 }, "Settings"); history.flush();
  history.rebase<Record<string, number>>("videos", current => ({ ...current, b: 9 }));
  history.undo(); assert.deepEqual(history.get("videos"), { a: 1, b: 9 });
  history.rebase<Record<string, number>>("videos", current => { const next = { ...current }; delete next.a; return next; });
  history.redo(); assert.deepEqual(history.get("videos"), { b: 9 }); assert.equal(history.undoLabel, undefined);
});
test("no-ops do not clear redo, gestures returning to their original value leave no step, history is bounded", () => {
  const history = new WorkspaceHistory(2); history.init("setting", 1);
  for (const n of [2, 3, 4]) { history.set("setting", n, "Setting"); history.flush(); }
  history.undo(); history.undo(); history.undo(); assert.equal(history.get("setting"), 2);
  history.set("setting", 2, "Setting"); assert.equal(history.redoLabel, "Setting");
  const other = new WorkspaceHistory(); other.init("value", 0); other.group = {};
  other.set("value", 1, "Value"); other.flush(); other.set("value", 0, "Value"); other.flush(); assert.equal(other.undoLabel, undefined);
});
test("prompt edits can be reached after later changes and restored across modes; saved presets persist when unmounted", () => {
  const history = new WorkspaceHistory(); const saved: unknown[] = [];
  history.init("manual", 0); history.init("auto", 0); history.init("presets", [], value => saved.push(value));
  history.context = { mode: "auto", sourceId: "video-a" };
  history.label("Apply prompt"); history.set("manual", 2, "Settings"); history.set("auto", 3, "Settings"); history.flush();
  history.set("presets", ["Test"], "Save preset"); history.flush(); history.undo();
  assert.deepEqual(saved.at(-1), []);
  const entry = history.undo(); assert.equal(entry?.label, "Apply prompt"); assert.equal(history.restoredContext?.sourceId, "video-a");
  assert.equal(history.get("manual"), 0); history.redo(); assert.equal(history.get("manual"), 2);
});

test("redoing a prompt that switches editing mode reveals the resulting workspace", () => {
  const history = new WorkspaceHistory(); history.init("manual", 0); history.context = { mode: "auto", sourceId: "a" };
  history.set("manual", 1, "Prompt"); history.navigateOnRedo({ mode: "manual", sourceId: "a" });
  assert.equal(history.undo()?.context?.mode, "auto"); assert.equal(history.redo()?.context?.mode, "manual");
});
