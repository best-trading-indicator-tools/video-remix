import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { renderVideo, probeMedia } from '../server/engine.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
const exec = promisify(execFile);

test('speed and flip render in sync with pitch-preserved source/narration audio and retimed supporting media', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remix-playback-render-'));
  try {
    const input = path.join(directory, 'source.mp4'), visual = path.join(directory, 'visual.mp4');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=30:d=4,drawbox=x=80:y=0:w=80:h=90:color=green:t=fill',
      '-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*if(lt(t\\,2)\\,440\\,880)*t):s=48000:d=4',
      '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=30:d=2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', visual]);
    const source = await probeMedia(input);
    for (const speed of [.5, 2]) for (const narration of [false, true]) {
      const output = path.join(directory, `output-${speed}-${narration}.mp4`);
      await renderVideo({ input, output, source, settings: { ...DEFAULT_SETTINGS, speed, mirror: true },
        audioPath: narration ? input : undefined, narration,
        supportingVisuals: [{ path: visual, start: 1 / speed, end: 3 / speed, playbackSpeed: speed, kind: 'broll', label: 'Blue shot' }],
        workDir: path.join(directory, `work-${speed}-${narration}`), signal: new AbortController().signal, onProgress: () => {} });
      const metadata = await probeMedia(output); assert.ok(Math.abs(metadata.duration - 4 / speed) < .1); assert.equal(metadata.hasAudio, true);
      for (const [time, channel] of [[.25 / speed, 1], [1.5 / speed, 2], [3.5 / speed, 1]]) {
        const pixel = (await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', output, '-frames:v', '1', '-vf', 'crop=2:2:20:40,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })).stdout;
        assert.ok(pixel[channel]! > 95, `Expected flipped green source or blue supporting shot at ${time}s`);
      }
      for (const [time, frequency] of [[.5 / speed, 440], [3.2 / speed, 880]]) {
        const samples = (await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', output, '-t', '0.3', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer' })).stdout;
        let crossings = 0; for (let i = 2; i < samples.length; i += 2) if (samples.readInt16LE(i - 2) < 0 && samples.readInt16LE(i) >= 0) crossings++;
        assert.ok(Math.abs(crossings / (samples.length / 16000) - frequency) < 25, `Pitch and timing preserved at ${speed}×, narration=${narration}`);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
