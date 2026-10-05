import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
const cache = new Map<string, Promise<{ peaks: number[]; duration: number }>>();
/** Stream low-rate PCM into a fixed number of peaks, without loading the soundtrack into memory. */
export async function audioWaveform(file: string, duration: number) {
  const info = await stat(file), key = `${file}:${info.size}:${info.mtimeMs}`;
  if (!cache.has(key)) {
    const pending = new Promise<{ peaks: number[]; duration: number }>((resolve, reject) => {
      const peaks = Array<number>(1200).fill(0), samplesPerBin = Math.max(1, duration * 1000 / peaks.length);
      let count = 0, tail = Buffer.alloc(0), error = '';
      const process = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpeg,mpegts,flv,ogg,asf,wav,mp3,flac,aac,aiff,nut', '-i', file, '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '1000', '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { process.kill('SIGKILL'); }, 60_000);
      process.stdout.on('data', (chunk: Buffer) => {
        const data = Buffer.concat([tail, chunk]), end = data.length - data.length % 4;
        for (let i = 0; i < end; i += 4) { const bin = Math.min(peaks.length - 1, Math.floor(count++ / samplesPerBin)); peaks[bin] = Math.max(peaks[bin]!, Math.min(1, Math.abs(data.readFloatLE(i)) || 0)); }
        tail = data.subarray(end);
      });
      process.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
      process.on('error', e => { clearTimeout(timer); reject(e); });
      process.on('close', code => { clearTimeout(timer); if (code && !/does not contain any stream|matches no streams/iu.test(error)) reject(new Error('The audio waveform could not be read.')); else resolve({ peaks: count ? peaks : [], duration }); });
    });
    if (cache.size >= 20) cache.delete(cache.keys().next().value!);
    cache.set(key, pending); pending.catch(() => cache.delete(key));
  }
  return cache.get(key)!;
}
