import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workingVideos, toggleWorkingVideo } from '../shared/working-selection.js';

const sources = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
const ids = (videos: { id: string }[]) => videos.map(video => video.id);

test('checking a second video extends the current working set without dropping the first', () => {
  const current = workingVideos(sources, 'one', 'current', []);
  const checked = toggleWorkingVideo(current, 'two', true);
  assert.deepEqual(ids(workingVideos(sources, 'one', 'selected', checked)), ['one', 'two']);
  assert.deepEqual(ids(workingVideos(sources, 'three', 'selected', checked)), ['one', 'two'], 'previewing an excluded video must not change the batch');
});

test('unchecking a video while working on all videos keeps every other target', () => {
  const all = workingVideos(sources, 'two', 'all', []);
  const checked = toggleWorkingVideo(all, 'two', false);
  assert.deepEqual(ids(workingVideos(sources, 'two', 'selected', checked)), ['one', 'three']);
});

test('unchecking the last video leaves an empty batch, never a fallback to the preview or all videos', () => {
  const current = workingVideos(sources, 'one', 'current', []);
  const checked = toggleWorkingVideo(current, 'one', false);
  assert.deepEqual(workingVideos(sources, 'one', 'selected', checked), []);
  assert.deepEqual(workingVideos(sources, 'two', 'selected', checked), []);
});

test('all videos includes new imports; checked videos remain explicit and expired sources disappear', () => {
  const updated = [...sources.slice(1), { id: 'new' }];
  assert.deepEqual(ids(workingVideos(updated, 'two', 'all', [])), ['two', 'three', 'new']);
  assert.deepEqual(ids(workingVideos(updated, 'two', 'selected', ['one', 'three', 'three'])), ['three']);
  assert.deepEqual(workingVideos([], undefined, 'all', ['one']), []);
  assert.deepEqual(workingVideos([], undefined, 'current', ['one']), []);
});

test('this video follows the preview and checked selection preserves source order without duplicates', () => {
  assert.deepEqual(ids(workingVideos(sources, 'two', 'current', ['one', 'three'])), ['two']);
  const checked = toggleWorkingVideo(sources, 'one', true);
  assert.deepEqual(ids(workingVideos(sources, 'two', 'selected', [...checked].reverse())), ['one', 'two', 'three']);
  assert.deepEqual(checked, ['one', 'two', 'three']);
});
