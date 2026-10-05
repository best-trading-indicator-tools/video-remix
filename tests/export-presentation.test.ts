import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportStatus, exportTitle, visibleExportChanges } from '../shared/export-presentation.js';
import { DEFAULT_SETTINGS, type RenderJob } from '../shared/types.js';
test('export cards use a readable title and one conservative status', () => {
  const job = { sourceName: 'hf_20261003_185034_4d1d2592-f0b7.mp4', variant: 1, settings: DEFAULT_SETTINGS, status: 'completed' } as RenderJob;
  assert.equal(exportTitle(job), 'Video · cut 1');
  assert.equal(exportTitle({ ...job, settings: { ...job.settings, hookText: 'Do pets stay at home?' } }), 'Do pets stay at home?');
  assert.equal(exportTitle({ ...job, exportName: 'My short' }), 'My short');
  assert.equal(exportStatus(job).kind, 'review');
  job.qualityReport = { status: 'pass', scope: 'full', issues: [], checkedAt: new Date().toISOString() };
  assert.equal(exportStatus(job).kind, 'ready');
  job.editorialReport = { status: 'unavailable' } as RenderJob['editorialReport'];
  assert.equal(exportStatus(job).kind, 'review');
  job.status = 'failed'; assert.equal(exportStatus(job).kind, 'problem');
  assert.deepEqual(visibleExportChanges(['0 uploaded cover shots', '2 uploaded segments inserted', 'Automatic captions']), ['2 uploaded segments inserted', 'Automatic captions']);
});
