import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(process.argv[2]);
const executable = path.resolve(process.argv[3]);
const binaries = path.resolve(process.argv[4]);
const directory = await mkdtemp(path.join(tmpdir(), 'remix-desktop-smoke-'));
const runtime = path.join(directory, 'engine'), data = path.join(directory, 'workspace');
const { prepareRuntime, desktopEnvironment, run } = await import(pathToFileURL(path.join(root, 'desktop/runtime.mjs')).href);
const { DEFAULT_SETTINGS } = await import(pathToFileURL(path.join(root, 'dist-server/shared/types.js')).href);
const token = randomBytes(32).toString('hex');
const env = { ...desktopEnvironment(root, runtime, data, binaries, executable), REMIX_DESKTOP_TOKEN: token,
  DEEPSEEK_API_KEY: '', PIXABAY_API_KEY: '', PEXELS_API_KEY: '', POSTIZ_API_KEY: '' };
let child;
try {
  await prepareRuntime(root, runtime);
  assert.ok(!(await readdir(runtime)).includes('.env'));
  assert.ok((await readFile(path.join(runtime, 'scripts/models/face_detection_yunet_2023mar.onnx'))).length > 100_000);
  const extension = process.platform === 'win32' ? '.exe' : '';
  for (const binary of ['ffmpeg', 'ffprobe', 'uv']) execFileSync(path.join(binaries, binary + extension), [binary === 'uv' ? '--version' : '-version'], { env, stdio: 'pipe' });
  // No system Node/Python/FFmpeg installation is used by the packaged engine.
  const runtimeInfo = JSON.parse(execFileSync(executable, ['-e', "console.log(JSON.stringify({node:process.versions.node,sqlite:!!require('node:sqlite').DatabaseSync}))"], { env, encoding: 'utf8' }));
  assert.ok(runtimeInfo.sqlite);
  child = spawn(executable, [path.join(root, 'dist-server/server/index.js')], { cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout.on('data', chunk => logs += chunk); child.stderr.on('data', chunk => logs += chunk);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Packaged engine did not start: ${logs}`)), 30_000);
    child.once('message', message => { clearTimeout(timer); assert.equal(message.type, 'ready'); resolve(message.port); });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Engine exited ${code}: ${logs}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 403);
  const headers = { 'X-Remix-Desktop': token };
  const health = await (await fetch(`${base}/api/health`, { headers })).json();
  assert.ok(health.ffmpeg && health.ffprobe, JSON.stringify(health));
  const page = await fetch(base, { headers }); assert.equal(page.status, 200); assert.match(await page.text(), /<html/);
  const input = path.join(directory, 'sample.mp4');
  await run(path.join(binaries, 'ffmpeg' + extension), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=12:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input], { cwd: runtime, env });
  const form = new FormData(); form.append('videos', new Blob([await readFile(input)]), 'Desktop smoke.mp4');
  const uploaded = await fetch(`${base}/api/sources`, { method: 'POST', headers, body: form });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const source = (await uploaded.json()).sources[0];
  const preview = await fetch(`${base}/api/previews`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: source.id, settings: { ...DEFAULT_SETTINGS, hookText: 'Desktop works', hookDuration: 1 } }) });
  assert.equal(preview.status, 201, `${await preview.clone().text()}\n${logs}`);
  const rendered = await preview.json(); const video = await fetch(base + rendered.url, { headers });
  assert.equal(video.status, 200); const output = path.join(directory, 'rendered.mp4'); await writeFile(output, Buffer.from(await video.arrayBuffer()));
  const info = JSON.parse(execFileSync(path.join(binaries, 'ffprobe' + extension), ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }));
  assert.ok(info.streams.some(stream => stream.codec_type === 'audio')); assert.ok(info.streams.some(stream => stream.codec_type === 'video' && stream.width === 320));
  console.log(`Desktop smoke passed: bundled Node ${runtimeInfo.node}, SQLite, FFmpeg, private server, import, text rendering and audio.`);
} finally {
  if (child && child.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
    });
  }
  await rm(directory, { recursive: true, force: true });
}
