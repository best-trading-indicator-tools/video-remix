import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoPicturePreview } from '../shared/preview-settings.js';
import { DEFAULT_AUTO_OPTIONS } from '../shared/types.js';
test('Auto picture samples keep actual upscale/framing settings without requesting AI planning or stock', () => {
  const sample = autoPicturePreview({ ...DEFAULT_AUTO_OPTIONS, aspect: '9:16', upscale: '2160', narration: true, visualSources: ['pexels'], editorialMode: 'repair' }, { width: 1920, height: 1080 });
  assert.equal(sample.upscale, '2160'); assert.equal(sample.fit, 'blur'); assert.equal(sample.aspect, '9:16');
  assert.equal(sample.automaticCaptions, undefined); assert.equal(sample.visualSources, undefined); assert.equal(sample.audioId, null);
  assert.equal(sample.trimStart, 0); assert.equal(sample.trimEnd, null);
  assert.equal(autoPicturePreview({ ...DEFAULT_AUTO_OPTIONS, aspect: 'original', upscale: 'off' }, { width: 640, height: 360 }).fit, 'crop');
});
