import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
}

test('stdio MCP imports, shares drafts across clients, appends footage and renders actual bulk MP4s through the app', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remix-mcp-render-'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, DATA_DIR: path.join(directory, 'data'), REMIX_MCP_DATA_DIR: path.join(directory, 'mcp'),
    PORT: String(port), HOST: '127.0.0.1', REMIX_API_URL: base, AUTO_AI: 'false', WHISPER_CACHE_DIR: path.join(directory, 'no-model'),
    DEEPSEEK_API_KEY: '', PIXABAY_API_KEY: '', PEXELS_API_KEY: '', RENDER_CONCURRENCY: '1' } as Record<string, string>;
  let backend: ChildProcess | undefined, log = '';
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client({ name: 'mcp-render-test', version: '1.0.0' }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'server/mcp/index.ts'], cwd: process.cwd(), env: environment, stderr: 'pipe' });
    transport.stderr?.on('data', chunk => { log = (log + chunk).slice(-5000); });
    await client.connect(transport); return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: 30_000 });
    const text = result.content.find(item => item.type === 'text');
    assert.ok(text?.type === 'text'); assert.equal(result.isError, undefined, text.text);
    return JSON.parse(text.text);
  };
  try {
    const source1 = path.join(directory, 'first.mp4'), source2 = path.join(directory, 'second.mp4'), outro = path.join(directory, 'outro.mp4');
    for (const [file, color, duration] of [[source1, 'red', 2], [source2, 'red', 2], [outro, 'blue', 1]] as const)
      await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:size=320x180:rate=24:duration=${duration}`, '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file]);
    backend = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [backend.stdout, backend.stderr]) stream?.on('data', chunk => { log = (log + chunk.toString()).slice(-5000); });
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Starting. */ }
      assert.ok(attempt < 100, log); await pause(100);
    }
    const client = await connect();
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'append_footage'));
    await call(client, 'import_videos', { paths: [source1, source2] });
    let videos;
    for (let attempt = 0; ; attempt++) {
      const imports = await call(client, 'list_imports');
      assert.ok(!imports.imports.some((item: any) => item.status === 'failed'), JSON.stringify(imports));
      videos = (await call(client, 'list_videos')).videos;
      if (videos.length === 2) break;
      assert.ok(attempt < 100, log); await pause(100);
    }
    const asset = (await call(client, 'import_footage', { path: outro })).assets[0];
    let draft = (await call(client, 'create_draft', { sourceIds: videos.map((item: any) => item.id), title: 'MCP integration batch', auto: {
      blackBands: { enabled: true, topText: 'BPC157', topStyle: { cyrillic: true, color: '#ffffff', fontPercent: 5.4 } },
    } })).draft;
    await client.close();
    const second = await connect();
    assert.equal((await call(second, 'get_draft', { draftId: draft.id })).draft.title, 'MCP integration batch');
    draft = (await call(second, 'append_footage', { draftId: draft.id, revision: draft.revision, assetId: asset.id, audio: 'mute' })).draft;
    assert.ok(draft.items.every((item: any) => item.options.ownFootageSourceId === item.sourceId));
    const receipt = await call(second, 'render_draft', { draftId: draft.id, revision: draft.revision });
    assert.equal(receipt.jobIds.length, 2);
    assert.deepEqual((await call(second, 'render_draft', { draftId: draft.id, revision: draft.revision })).jobIds, receipt.jobIds);
    for (const jobId of receipt.jobIds) {
      let job;
      for (let attempt = 0; ; attempt++) {
        job = await call(second, 'get_export', { jobId });
        if (job.status === 'completed') break;
        assert.ok(['queued', 'processing'].includes(job.status), JSON.stringify(job));
        assert.ok(attempt < 150, log); await pause(100);
      }
      const output = path.join(directory, `${jobId}.mp4`);
      await writeFile(output, new Uint8Array(await (await fetch(job.downloadUrl)).arrayBuffer()));
      const metadata = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', output])).stdout);
      assert.ok(Math.abs(Number(metadata.format.duration) - 3) < .12, 'The entire one-second outro must be appended to each two-second source');
      const plan = await (await fetch(`${base}/api/jobs/${jobId}/plan`)).json();
      assert.equal(plan.settings.blackBands.topText, 'BPC157'); assert.equal(plan.settings.blackBands.topStyle.cyrillic, true);
      for (const [time, channel] of [[.5, 0], [2.5, 2]] as const) {
        const video = metadata.streams.find((stream: any) => stream.width);
        const pixel = (await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', output, '-frames:v', '1', '-vf', `crop=2:2:${Math.floor(video.width / 2)}:${Math.floor(video.height / 2)},scale=1:1`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })).stdout;
        assert.ok(pixel[channel]! > 180, 'The main picture is red, and the appended ending is blue');
      }
    }
    const appJobs = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(appJobs.jobs.length, 2, 'Both exports are in the ordinary app queue with no duplicate batch');
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await stop(backend); await rm(directory, { recursive: true, force: true });
  }
});
