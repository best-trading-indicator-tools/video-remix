import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildFootagePreview, footagePreviewPosition } from '../shared/footage-preview.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { footageTimeline, resolveFootagePlacement, type OwnFootageAsset, type OwnFootagePlacement } from '../shared/own-footage.js';

const source = { duration: 50, fps: 30 };
const asset: OwnFootageAsset = { id: randomUUID(), name: 'My footage', duration: 14, hasAudio: true, url: '/clip.mp4' };
const clip = (patch: Partial<OwnFootagePlacement> = {}): OwnFootagePlacement => ({
  id: randomUUID(), assetId: asset.id, mode: 'insert', at: 0, start: 0, end: 2, audio: 'clip', fit: 'contain', ...patch,
});

test('live outro includes the whole asset after the source and uses the same duration as export', () => {
  const outro = clip({ appendToEnd: true, at: 12, start: 4, end: 5 });
  const timeline = buildFootagePreview(source, [outro], [asset]);
  assert.equal(timeline.duration, 64);
  assert.deepEqual(timeline.segments.map(item => [item.kind, item.start, item.end, item.mediaStart]), [['source', 0, 50, 0], ['insert', 50, 64, 0]]);
  assert.equal(footagePreviewPosition(timeline, 49).segment.kind, 'source');
  assert.equal(footagePreviewPosition(timeline, 50).segment.kind, 'insert');
  assert.equal(footagePreviewPosition(timeline, 63).mediaTime, 13);
  assert.equal(footagePreviewPosition(timeline, 64).mediaTime, 14);
  assert.equal(timeline.duration, footageTimeline([resolveFootagePlacement(outro, asset.duration)], source.duration, source.fps).duration);
});

test('insertions pause the base edit and cover media, then resume their original clocks', () => {
  const intro = clip({ end: 1 }), middle = clip({ at: 2, start: 5, end: 7, audio: 'mute', fit: 'crop' });
  const cover = clip({ mode: 'cover', at: 1, start: 3, end: 7 });
  const timeline = buildFootagePreview(source, [cover, middle, intro], [asset]);
  assert.equal(timeline.duration, 53);
  const before = footagePreviewPosition(timeline, 2.5);
  assert.equal(before.segment.kind, 'cover'); assert.equal(before.mediaTime, 3.5); assert.equal(before.sourceTime, 1.5);
  const during = footagePreviewPosition(timeline, 4);
  assert.equal(during.segment.kind, 'insert'); assert.equal(during.mediaTime, 6);
  assert.equal(during.segment.placement?.audio, 'mute'); assert.equal(during.segment.placement?.fit, 'crop');
  const resumed = footagePreviewPosition(timeline, 5.5);
  assert.equal(resumed.segment.kind, 'cover'); assert.equal(resumed.mediaTime, 4.5); assert.equal(resumed.sourceTime, 2.5);
  const after = footagePreviewPosition(timeline, 8);
  assert.equal(after.segment.kind, 'source'); assert.equal(after.mediaTime, 5);
  for (let index = 1; index < timeline.segments.length; index++) assert.equal(timeline.segments[index].start, timeline.segments[index - 1].end);
});

test('manual cuts and speed apply to source footage; inserted clips keep normal speed', () => {
  const settings = { ...DEFAULT_SETTINGS, speed: 2, segments: [{ start: 2, end: 6 }, { start: 10, end: 14, focalPoint: { x: 0.8, y: 0.4 } }] };
  const insert = clip({ at: 1, start: 7, end: 9 }), outro = clip({ appendToEnd: true });
  const timeline = buildFootagePreview(source, [insert, outro], [asset], settings);
  assert.equal(timeline.duration, 20);
  assert.equal(footagePreviewPosition(timeline, 0.5).mediaTime, 3);
  assert.equal(footagePreviewPosition(timeline, 1.5).mediaTime, 7.5);
  assert.equal(footagePreviewPosition(timeline, 1.5).segment.mediaRate, 1);
  assert.equal(footagePreviewPosition(timeline, 3.5).mediaTime, 5);
  assert.equal(footagePreviewPosition(timeline, 4.5).mediaTime, 11);
  assert.deepEqual(footagePreviewPosition(timeline, 4.5).segment.focalPoint, { x: 0.8, y: 0.4 });
  assert.equal(footagePreviewPosition(timeline, 6).segment.placement?.id, outro.id);
});

test('cover playback retains source speed and trims, without changing cover speed or duration', () => {
  const timeline = buildFootagePreview(source, [clip({ mode: 'cover', at: 1, start: 2, end: 6 })], [asset],
    { ...DEFAULT_SETTINGS, trimStart: 3, trimEnd: 15, timeShift: 2, speed: 2 });
  assert.equal(timeline.duration, 6);
  const position = footagePreviewPosition(timeline, 2);
  assert.equal(position.segment.kind, 'cover');
  assert.equal(position.sourceTime, 9); assert.equal(position.segment.sourceRate, 2);
  assert.equal(position.mediaTime, 3); assert.equal(position.segment.mediaRate, 1);
});

test('multiple outros keep list order and cover shots outside the edit are not shown', () => {
  const first = clip({ appendToEnd: true }), second = clip({ appendToEnd: true });
  const cover = clip({ mode: 'cover', at: 60 }), late = clip({ at: 100 });
  const timeline = buildFootagePreview(source, [first, second, cover, late], [asset]);
  assert.deepEqual(timeline.segments.flatMap(item => item.placement?.id ?? []), [first.id, second.id, late.id]);
  assert.equal(timeline.duration, 80);
});

test('missing assets and invalid placements produce an explicit error instead of a misleading source-only preview', () => {
  assert.throws(() => buildFootagePreview(source, [clip()], []), /unavailable/);
  assert.throws(() => buildFootagePreview(source, [clip({ end: 20 })], [asset]), /beyond/);
  assert.throws(() => buildFootagePreview(source, [clip({ start: 4, end: 2 })], [asset]), /start, end/);
  assert.throws(() => buildFootagePreview(source, [clip({ mode: 'cover' }), clip({ mode: 'cover', at: 1 })], [asset]), /overlap/);
  assert.throws(() => buildFootagePreview(source, [clip()], [asset], { ...DEFAULT_SETTINGS, segments: [{ start: 0, end: 60 }] }), /valid source cuts/);
});
