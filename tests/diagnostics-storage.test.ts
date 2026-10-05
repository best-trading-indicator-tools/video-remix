import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDiagnostic } from '../shared/diagnostics.js';

test('loading saved diagnostics removes old polling/startup noise from storage while keeping failed actions', async () => {
  const key = 'remix-support-events-v1';
  const action = makeDiagnostic('Could not connect to the video engine. Check that the server is running.', { operation: 'POST /api/jobs', method: 'POST', endpoint: '/api/jobs' });
  const setup = makeDiagnostic('FFmpeg is not ready. Install FFmpeg and ffprobe, then restart the server.', { operation: 'Connect to video engine' });
  const old = [
    makeDiagnostic('The server returned an invalid response. Please refresh and try again.', { operation: 'GET /api/auto/capabilities' }),
    makeDiagnostic('Could not connect to the video engine. Check that the server is running.', { operation: 'GET /api/sources', method: 'GET', endpoint: '/api/sources' }),
    makeDiagnostic('Request failed (502). Please try again.', { operation: 'GET /api/jobs', httpStatus: 502 }),
    makeDiagnostic('Connection to the video engine was lost. Your workspace will reconnect automatically.', { operation: 'Connect to video engine' }),
    makeDiagnostic('Could not connect to the video engine. Check that the server is running.', { operation: 'Workspace action' }),
    makeDiagnostic('Your video library could not be loaded. Refresh to try again.', { operation: 'Workspace action' }),
    makeDiagnostic('Speech required', { operation: 'Editorial check' }), action, setup,
  ];
  const saved = new Map([[key, JSON.stringify(old)]]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (name: string) => saved.get(name) ?? null,
    setItem: (name: string, value: string) => { saved.set(name, value); },
  } });
  try {
    const { getDiagnostics, recordDiagnostic, clearDiagnostics } = await import('../src/diagnostics-store.js');
    assert.deepEqual(getDiagnostics().map(issue => issue.id), [action.id, setup.id]);
    assert.deepEqual(JSON.parse(saved.get(key)!).map((issue: { id: string }) => issue.id), [action.id, setup.id]);
    clearDiagnostics();
    for (const issue of old.slice(0, 7)) recordDiagnostic(issue);
    assert.deepEqual(getDiagnostics(), []); assert.deepEqual(JSON.parse(saved.get(key)!), []);
    recordDiagnostic(action); assert.equal(getDiagnostics().length, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
