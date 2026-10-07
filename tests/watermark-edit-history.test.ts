import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WATERMARK_REMOVAL, activeRemovalMasks, type WatermarkRemoval } from "../shared/watermark-removal.js";
import { rememberWatermarkEdit, restoreWatermarkEdit, type WatermarkEdit } from "../shared/watermark-edit-history.js";

const empty: WatermarkRemoval = { enabled: true, mode: "fixed", masks: [{ id: "area", start: 0, end: 5, fill: "lama", strokes: [] }] };
const marked: WatermarkRemoval = { ...empty, masks: [{ ...empty.masks[0]!, strokes: [{ kind: "brush", size: .04, points: [{ x: .3, y: .2 }] }] }] };
function editor(initial: WatermarkRemoval = DEFAULT_WATERMARK_REMOVAL) {
  let value = structuredClone(initial), history: WatermarkEdit[] = [];
  return {
    get value() { return value; }, get canUndo() { return history.length > 0; },
    change(next: WatermarkRemoval, record = true) { history = rememberWatermarkEdit(history, value, next, record); value = structuredClone(next); },
    undo() { const previous = history.pop(); if (previous) value = restoreWatermarkEdit(value, previous); },
  };
}

test("undoing the first brush stroke keeps removal on and the deleted mark stays gone after OFF/ON", () => {
  const edit = editor();
  edit.change(empty); assert.equal(edit.canUndo, false, "Enabling is not a drawing edit");
  edit.change(marked); edit.undo();
  assert.equal(edit.value.enabled, true);
  assert.deepEqual(edit.value.masks[0]!.strokes, []);
  assert.equal(edit.canUndo, false);
  edit.undo(); assert.equal(edit.value.enabled, true, "Extra Undo cannot disable removal");
  edit.change({ ...edit.value, enabled: false }); edit.change({ ...edit.value, enabled: true });
  assert.deepEqual(edit.value.masks[0]!.strokes, []);
  assert.ok(activeRemovalMasks(JSON.parse(JSON.stringify(edit.value)), 1).every(mask => !mask.strokes.length), "Saved settings contain no resurrected mark");
});

test("re-enabling existing marks starts with no Undo action for the checkbox", () => {
  const edit = editor({ ...marked, enabled: false });
  edit.change({ ...edit.value, enabled: true });
  assert.equal(edit.canUndo, false);
  edit.undo(); assert.deepEqual(edit.value, marked);
  edit.change(empty); edit.undo(); assert.deepEqual(edit.value, marked, "Explicitly undoing Clear does restore the area");
  edit.change(empty); edit.change({ ...edit.value, enabled: false }); edit.change({ ...edit.value, enabled: true });
  assert.deepEqual(edit.value.masks[0]!.strokes, [], "Cleared marks must stay cleared across toggles");
  assert.equal(edit.canUndo, false, "The new editing session cannot restore older marks");
});

test("Undo retains earlier strokes and timed areas without changing the checkbox", () => {
  const edit = editor(marked);
  const timed: WatermarkRemoval = { ...marked, mode: "timed", masks: [...marked.masks, { ...marked.masks[0]!, id: "second", start: 2, end: 4 }] };
  edit.change(timed); edit.change({ ...timed, masks: [timed.masks[1]!] });
  edit.undo(); assert.deepEqual(edit.value, timed);
  edit.undo(); assert.deepEqual(edit.value, marked);
  assert.equal(edit.canUndo, false);
  const { enabled: _, ...snapshot } = empty;
  assert.equal(restoreWatermarkEdit({ ...marked, enabled: false }, snapshot).enabled, false);
});

test("initializing an empty editor and unchanged values do not create phantom Undo steps", () => {
  const edit = editor({ ...DEFAULT_WATERMARK_REMOVAL, enabled: true });
  edit.change(empty, false); assert.equal(edit.canUndo, false);
  edit.change(structuredClone(empty)); assert.equal(edit.canUndo, false);
  edit.change(marked); edit.change(structuredClone(marked)); edit.undo();
  assert.deepEqual(edit.value, empty); assert.equal(edit.canUndo, false);
});
