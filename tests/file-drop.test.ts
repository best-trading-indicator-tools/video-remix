import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFileDrop } from '../src/file-drop.js';

function fixture() {
  const window = new EventTarget();
  const target = Object.assign(new EventTarget(), { ownerDocument: { defaultView: window } });
  const batches: File[][] = [], highlights: boolean[] = [];
  let allowed = true;
  const dispose = bindFileDrop(target as unknown as HTMLElement, {
    canDrop: () => allowed, onFiles: files => batches.push(files), onDragging: value => highlights.push(value),
  });
  function send(type: string, files: File[] = [], types = ['Files']) {
    const event = new Event(type, { cancelable: true });
    const dataTransfer = { files, types, dropEffect: 'none' };
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(event);
    return { event, dataTransfer };
  }
  return { window, batches, highlights, dispose, send, allow: (value: boolean) => { allowed = value; } };
}

test('dropping multiple files queues the entire batch once and prevents video navigation', () => {
  const f = fixture();
  const files = [new File(['one'], 'first.mp4'), new File(['two'], 'second.mov')];
  f.send('dragenter');
  assert.equal(f.send('dragover').dataTransfer.dropEffect, 'copy');
  assert.equal(f.send('drop', files).event.defaultPrevented, true);
  assert.deepEqual(f.batches, [files]);
  assert.deepEqual(f.highlights, [true, false]);
  f.dispose();
  assert.equal(f.send('drop', files).event.defaultPrevented, false);
  assert.equal(f.batches.length, 1, 'Unmounted panels must not retain import listeners');
});

test('crossing nested buttons and video cards keeps the highlight until leaving the panel', () => {
  const f = fixture();
  f.send('dragenter'); f.send('dragenter'); f.send('dragleave');
  assert.deepEqual(f.highlights, [true]);
  f.send('dragleave');
  assert.deepEqual(f.highlights, [true, false]);
  f.send('dragenter'); f.window.dispatchEvent(new Event('dragend'));
  assert.deepEqual(f.highlights, [true, false, true, false]);
  f.dispose();
});

test('a disconnected or preparing importer rejects files without navigating, then accepts later drops', () => {
  const f = fixture(), files = [new File(['video'], 'clip.mp4')];
  f.send('dragenter'); f.allow(false);
  assert.equal(f.send('dragover').dataTransfer.dropEffect, 'none');
  assert.equal(f.send('drop', files).event.defaultPrevented, true);
  assert.deepEqual(f.batches, []);
  assert.deepEqual(f.highlights, [true, false]);
  f.allow(true); f.send('drop', files);
  assert.deepEqual(f.batches, [files]);
  f.dispose();
});

test('text, links, internal clip drags and empty file drops do not open imports', () => {
  const f = fixture();
  for (const types of [['text/plain'], ['text/uri-list'], ['application/x-remix-media']]) {
    assert.equal(f.send('dragenter', [], types).event.defaultPrevented, false);
    assert.equal(f.send('dragover', [], types).event.defaultPrevented, false);
    assert.equal(f.send('drop', [], types).event.defaultPrevented, false);
  }
  f.send('drop');
  assert.deepEqual(f.highlights, []);
  assert.deepEqual(f.batches, []);
  f.dispose();
});
