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
    const embeddedTextRegions = [{ x: .1, y: .65, width: .8, height: .25 }];
    const source1 = path.join(directory, 'first.mp4'), source2 = path.join(directory, 'second.mp4'), outro = path.join(directory, 'outro.mp4');
    for (const [file, color, duration] of [[source1, 'red', 2], [source2, 'red', 2], [outro, 'blue', 1]] as const)
      await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:size=320x180:rate=24:duration=${duration}${file === outro ? '' : ",drawbox=x=160:y=0:w=160:h=180:color=green:t=fill,drawtext=fontfile=public/caption-fonts/Poppins-Bold.ttf:text='SOURCE TEXT':fontsize=16:fontcolor=white:x=(w-text_w)/2:y=135"}`, '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file]);
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
      textEdits: [{ action: 'add', text: 'MCP TITLE', design: 'bold', end: 1.5, style: { fontSize: 18, bottomPercent: 70 } }],
      blackBands: { enabled: true, topText: 'BPC157', topStyle: { cyrillic: true, color: '#ffffff', fontPercent: 5.4 } },
    } })).draft;
    await client.close();
    const second = await connect();
    assert.equal((await call(second, 'get_draft', { draftId: draft.id })).draft.title, 'MCP integration batch');
    draft = (await call(second, 'append_footage', { draftId: draft.id, revision: draft.revision, assetId: asset.id, audio: 'mute' })).draft;
    assert.ok(draft.items.every((item: any) => item.options.ownFootageSourceId === item.sourceId));
    // Set speed for all, then independently flip and speed up one checked video.
    draft = (await call(second, 'update_draft', { draftId: draft.id, revision: draft.revision, auto: { speed: .5 } })).draft;
    draft = (await call(second, 'update_draft', { draftId: draft.id, revision: draft.revision, sourceIds: [videos[0].id], auto: { speed: 2, mirror: true, preserveEmbeddedText: true, embeddedTextRegions } })).draft;
    assert.equal(draft.items[1].options.speed, .5); assert.equal(draft.items[1].options.mirror ?? false, false);
    const preview = await call(second, 'preview_draft', { draftId: draft.id, revision: draft.revision, sourceId: videos[0].id });
    assert.deepEqual(preview.embeddedText, { method: 'manual', regions: embeddedTextRegions });
    assert.equal((await fetch(new URL(preview.url, base))).status, 200);
    assert.equal((await (await fetch(`${base}/api/jobs`)).json()).jobs.length, 0);
    assert.equal(draft.items[1].options.preserveEmbeddedText ?? false, false);
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
      const speed = job.sourceId === videos[0].id ? 2 : .5;
      assert.ok(Math.abs(Number(metadata.format.duration) - (2 / speed + 1)) < .12, 'Speed affects the source while the entire outro retains its original duration');
      const plan = await call(second, 'get_saved_edit', { jobId });
      assert.equal(job.embeddedText?.method, speed === 2 ? "manual" : undefined);
      assert.equal(plan.settings.preserveEmbeddedText ?? false, speed === 2);
      assert.equal(plan.settings.speed, speed); assert.equal(plan.settings.mirror, speed === 2);
      assert.equal(plan.settings.textOverlays[0].text, 'MCP TITLE');
      assert.equal(plan.settings.textOverlays[0].style.animation, 'pop');
      const changed = await call(second, 'preview_saved_edit', { jobId, changes: { revision: plan.revision, textOverlays: plan.settings.textOverlays.map((text: any) => ({ ...text, style: { ...text.style, fontSize: 30 } })) } });
      assert.equal(changed.settings.textOverlays[0].style.fontSize, 30);
      assert.equal((await call(second, 'get_saved_edit', { jobId })).settings.textOverlays[0].style.fontSize, 18);
      const saved = await call(second, 'save_saved_draft', { jobId, revision: plan.revision, content: JSON.stringify({ draft: changed }), token: null });
      assert.equal((await call(second, 'get_saved_draft', { jobId })).draft.token, saved.draft.token);
      await call(second, 'discard_saved_draft', { jobId, token: saved.draft.token });
      assert.equal((await call(second, 'get_saved_draft', { jobId })).draft, null);
      await call(second, 'set_export_review', { jobIds: [jobId], review: { verdict: 'accepted-unchanged', notes: 'MCP test' } });
      assert.equal((await call(second, 'get_export_review', { jobId })).review.verdict, 'accepted-unchanged');
      assert.equal(plan.settings.blackBands.topText, 'BPC157'); assert.equal(plan.settings.blackBands.topStyle.cyrillic, true);
      for (const [time, channel] of [[.5, speed === 2 ? 1 : 0], [2 / speed + .5, 2]] as const) {
        const video = metadata.streams.find((stream: any) => stream.width);
        const pixel = (await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', output, '-frames:v', '1', '-vf', `crop=2:2:${Math.floor(video.width / 4)}:${Math.floor(video.height / 2)},scale=1:1`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })).stdout;
        assert.ok(pixel[channel]! > 90 && pixel[channel]! > pixel[(channel + 2) % 3]! + 45, 'The flipped source is green on the left; the unflipped source is red; the ending stays blue');
      }
    }
    const appJobs = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(appJobs.jobs.length, 2, 'Both exports are in the ordinary app queue with no duplicate batch');
    const savedJobId = receipt.jobIds[0];
    const savedPlan = await call(second, 'get_saved_edit', { jobId: savedJobId });
    const revision = await call(second, 'render_saved_edit', { jobId: savedJobId, changes: { revision: savedPlan.revision, framing: { speed: 1.25, mirror: false } } });
    let revised;
    for (let attempt = 0; attempt < 150; attempt++) {
      revised = await call(second, 'get_export', { jobId: revision.id });
      if (revised.status === 'completed') break;
      assert.ok(['queued', 'processing'].includes(revised.status), JSON.stringify(revised)); await pause(100);
    }
    assert.equal(revised.status, 'completed'); assert.deepEqual(revised.playback, { speed: 1.25, mirror: false, preserveEmbeddedText: true, embeddedTextRegions });
    assert.equal(revised.embeddedText, undefined);
    const revisedPlan = await call(second, 'get_saved_edit', { jobId: revision.id });
    assert.equal(revisedPlan.outputDuration, 1.6); assert.equal(revisedPlan.settings.mirror, false);
    assert.equal(revision.auto.speed, 1.25); assert.equal(revision.auto.mirror, false);
    const revisedFile = path.join(directory, 'revision.mp4');
    await writeFile(revisedFile, new Uint8Array(await (await fetch(revised.downloadUrl)).arrayBuffer()));
    const revisedDuration = Number((await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', revisedFile])).stdout.trim());
    assert.ok(Math.abs(revisedDuration - 2.6) < .12, 'The revised source is 1.6 seconds and retains the one-second outro');
    const captionsFile = path.join(directory, 'captions.srt');
    await writeFile(captionsFile, '1\n00:00:00,000 --> 00:00:01,500\nacme hello\n');
    const attachment = await call(second, 'import_attachment', { path: captionsFile, kind: 'subtitle' });
    const attachments = await call(second, 'list_attachments');
    assert.equal(attachments.attachments[0].id, attachment.id);
    assert.equal('filePath' in attachments.attachments[0], false);
    const manual = (await call(second, 'create_draft', { sourceIds: [videos[0].id], mode: 'manual', manual: {
      speed: .5, mirror: true, preserveEmbeddedText: true, embeddedTextRegions, subtitleId: attachment.id, captionCorrections: [{ find: 'acme', replace: 'ACME' }], captionStyle: { animation: 'words' },
    } })).draft;
    const manualSample = await call(second, 'preview_draft', { draftId: manual.id, revision: manual.revision, sourceId: videos[0].id });
    assert.equal(manualSample.embeddedText.method, 'manual');
    const rendered = await call(second, 'render_draft', { draftId: manual.id, revision: manual.revision });
    let corrected;
    for (let attempt = 0; attempt < 150; attempt++) {
      corrected = await call(second, 'get_export', { jobId: rendered.jobIds[0] });
      if (corrected.status === 'completed') break;
      assert.ok(['queued', 'processing'].includes(corrected.status), JSON.stringify(corrected)); await pause(100);
    }
    assert.equal(corrected.embeddedText.method, 'manual');
    assert.equal(corrected.status, 'completed'); assert.ok(corrected.captionUrl);
    assert.equal(corrected.playback.speed, .5); assert.equal(corrected.playback.mirror, true);
    assert.match(await (await fetch(corrected.captionUrl)).text(), /ACME hello/);
    await call(second, 'keep_exports', { jobIds: receipt.jobIds });
    const accepted = await call(second, 'get_download_links', { jobIds: receipt.jobIds, accepted: true });
    assert.equal((await fetch(accepted.accepted)).status, 200);
    const catalog = await call(second, 'get_editing_catalog'); assert.equal(catalog.titleDesigns.length, 4);

  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await stop(backend); await rm(directory, { recursive: true, force: true });
  }
});
