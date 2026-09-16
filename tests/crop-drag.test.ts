import assert from "node:assert/strict";
import { test } from "node:test";
import { containedMediaRectangle, dragCropPoint, visibleCropCenter } from "../shared/crop-drag.js";
import { shortCropGuide } from "../shared/shorts.js";

test("drag geometry measures the contained picture without letterbox padding", () => {
  assert.deepEqual(containedMediaRectangle(800, 600, 1920, 1080), { left: 0, top: 75, width: 800, height: 450 });
  assert.deepEqual(containedMediaRectangle(800, 600, 1080, 1920), { left: 231.25, top: 0, width: 337.5, height: 600 });
  for (const size of [0, -1, Number.NaN, Infinity]) assert.equal(containedMediaRectangle(size, 600, 1920, 1080), null);
});

test("pointer motion follows visible pixels and locks the full-height axis", () => {
  const crop = shortCropGuide({ width: 1920, height: 1080 }, "9:16", 1, { x: 0.5, y: 0.9 });
  const center = visibleCropCenter(crop);
  const picture = containedMediaRectangle(800, 600, 1920, 1080)!;
  assert.deepEqual(center, { x: 0.5, y: 0.5 });
  assert.deepEqual(dragCropPoint(crop, center, 80, 200, picture), { x: 0.6, y: 0.5 });
  assert.deepEqual(dragCropPoint(crop, center, 1e6, -1e6, picture), { x: crop.maxX, y: 0.5 });
  assert.deepEqual(dragCropPoint(crop, center, -1e6, 1e6, picture), { x: crop.minX, y: 0.5 });
});

test("a zoomed crop follows both axes and cannot leave the source picture", () => {
  const source = { width: 1080, height: 1920 };
  const crop = shortCropGuide(source, "9:16", 2, { x: 0.5, y: 0.5 });
  const picture = containedMediaRectangle(800, 600, source.width, source.height)!;
  const moved = dragCropPoint(crop, visibleCropCenter(crop), 33.75, 60, picture);
  assert.deepEqual(moved, { x: 0.6, y: 0.6 });
  const edge = dragCropPoint(crop, moved, 2000, 2000, picture);
  const guide = shortCropGuide(source, "9:16", 2, edge);
  assert.equal(guide.left + guide.width, 1);
  assert.equal(guide.top + guide.height, 1);
});

test("dragging starts at the clamped visible crop and invalid measurements keep it unchanged", () => {
  const crop = shortCropGuide({ width: 1920, height: 1080 }, "9:16", 1, { x: 1, y: 0 });
  const center = visibleCropCenter(crop);
  assert.equal(center.x, crop.maxX);
  assert.deepEqual(dragCropPoint(crop, center, 0, 0, { width: 800, height: 450 }), center);
  assert.ok(dragCropPoint(crop, center, -8, 0, { width: 800, height: 450 }).x < center.x,
    "Moving inward responds immediately instead of crossing an invisible overshoot first");
  assert.deepEqual(dragCropPoint(crop, center, Number.NaN, Infinity, { width: 800, height: 450 }), center);
  assert.deepEqual(dragCropPoint(crop, center, 20, 20, { width: 0, height: 0 }), center);
});
