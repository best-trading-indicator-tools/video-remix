import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { StoredJob, StoredSource } from '../server/store.js';

test('export tools persist names and quick verdicts without losing metrics, and preview timeline edits without mutating the export', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'export-tools-')); process.env.DATA_DIR = dir;
  const { initStore, state, saveStore, closeStore, historyRecords } = await import('../server/store.js');
  const { installExportTools } = await import('../server/export-tools.js');
  const { historyEntry, upsertHistory } = await import('../server/history.js');
  const { measurementSummary } = await import('../server/measurements.js');
  const { DEFAULT_SETTINGS } = await import('../shared/types.js');
  const { default: express } = await import('express');
  await initStore();
  const file = path.join(dir,'source.mp4');
  await promisify(execFile)('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=black:s=160x90:r=24:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-threads','1','-c:a','aac',file]);
  const source: StoredSource = { id:'source',name:'Test',fingerprint:'a'.repeat(64),filePath:file,thumbnailPath:path.join(dir,'unused.jpg'),thumbnailUrl:'',duration:2,width:160,height:90,fps:24,hasAudio:true,size:(await stat(file)).size,createdAt:new Date().toISOString() };
  const job: StoredJob = { id:'job',sourceId:'source',sourceName:'Test',variant:1,batchId:'batch',status:'completed',progress:100,createdAt:new Date().toISOString(),settings:{...DEFAULT_SETTINGS},outputPath:file,
    editPlan:{version:1,revision:1,sourceId:'source',sourceDuration:2,outputDuration:2,createdAt:new Date().toISOString(),settings:{...DEFAULT_SETTINGS},cuts:[{start:0,end:2}],captions:[],visuals:[],media:[],narration:false} };
  state.sources.push(source); state.jobs.push(job);
  const entry = historyEntry(source,job)!; entry.measurements={review:{openingClear:true,notes:'Earlier note'},posts:[{platform:'youtube',measuredAt:new Date().toISOString(),views:42}]};
  await saveStore([entry]);
  const app=express(); app.use(express.json()); installExportTools(app);
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=(url:string,body?:unknown,method='PATCH')=>fetch(base+url,{method:body===undefined?'GET':method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  try {
    assert.equal((await request('/api/jobs/job/title',{title:'My edited short'})).status,200);
    assert.equal(job.exportName,'My edited short'); assert.equal(historyRecords({jobId:'job'})[0]!.title,'My edited short');
    assert.equal(upsertHistory(historyRecords(),historyEntry(source,job)!)[0]!.title,'My edited short');
    assert.equal((await request('/api/jobs/job/title',{title:''})).status,400);
    assert.equal((await request('/api/jobs/job/review',{verdict:'accepted-unchanged',notes:'Ready to post'})).status,200);
    const saved=historyRecords({jobId:'job'})[0]!;
    assert.equal(saved.measurements!.review!.openingClear,true); assert.equal(saved.measurements!.posts![0]!.views,42);
    assert.equal(saved.measurements!.review!.verdict,'accepted-unchanged');
    assert.match(JSON.stringify(measurementSummary([saved])),/"acceptedUnchanged":1/);
    assert.equal((await request('/api/jobs/job/review',{notes:'Updated note'})).status,200);
    assert.equal(historyRecords({jobId:'job'})[0]!.measurements!.review!.verdict,'accepted-unchanged');
    assert.equal((await request('/api/jobs/job/review',{verdict:'rejected',notes:'Needs a stronger opening'})).status,200);
    assert.match(JSON.stringify(measurementSummary(historyRecords())),/"rejected":1/);
    const preview=await request('/api/jobs/job/plan/preview',{revision:1,cuts:[{start:0,end:1},{start:1,end:2}]},'POST');
    assert.equal(preview.status,200); assert.equal((await preview.json()).cuts.length,2); assert.equal(job.editPlan!.cuts.length,1);
    const waveform=await request('/api/jobs/job/waveform'); assert.equal(waveform.status,200);
    const wave=await waveform.json(); assert.equal(wave.clock,'source'); assert.equal(wave.peaks.length,1200); assert.ok(wave.peaks.some((peak:number)=>peak>0));
    const thumb=await request('/api/jobs/job/thumbnail'); assert.equal(thumb.status,200); assert.match(thumb.headers.get('content-type')!,/image\/jpeg/);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); closeStore(); await rm(dir,{recursive:true,force:true}); }
});
