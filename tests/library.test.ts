import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EMPTY_FILTERS, matchesExport, reviewStatus, revisionFamilies } from '../shared/library.js';
import { DEFAULT_SETTINGS, type RenderJob, type ExportHistoryEntry } from '../shared/types.js';
import { WorkspaceDatabase } from '../server/database.js';
const job: RenderJob = {id:'child',parentJobId:'root',batchId:'batch',sourceId:'source',sourceName:'Recording',exportName:'New idea',project:'Launch',variant:1,createdAt:'2026-10-01T10:00:00Z',status:'completed',progress:100,settings:{...DEFAULT_SETTINGS,aspect:'9:16'},review:{verdict:'accepted-after-correction'},publicationStatus:'scheduled'};
test('export filters combine human decisions, projects, format, dates and publication state',()=>{
  assert.equal(reviewStatus(), 'unreviewed'); assert.equal(reviewStatus(job.review),'accepted'); assert.equal(reviewStatus({verdict:'needs-edit'}),'needs-edit');
  assert.equal(matchesExport(job,{...EMPTY_FILTERS,search:' launch ',review:'accepted',publication:'scheduled',project:'Launch',aspect:'9:16',after:'2026-10-01',before:'2026-10-01'}),true);
  for (const patch of [{review:'unreviewed'},{publication:'published'},{project:'Other'},{aspect:'16:9'},{before:'2026-09-30'},{after:'2026-10-02'},{search:'absent'}]) assert.equal(matchesExport(job,{...EMPTY_FILTERS,...patch} as typeof EMPTY_FILTERS),false);
  assert.equal(matchesExport({...job,status:'processing',review:undefined},{...EMPTY_FILTERS,review:'unreviewed'}),false);
});
test('revisions group when results arrive newest first or the original has expired',()=>{
  const items=[{id:'third',parentJobId:'second'},{id:'unrelated'},{id:'second',parentJobId:'first'},{id:'first'}];
  assert.deepEqual(revisionFamilies(items).map(f=>f.map(x=>x.id)),[['third','second','first'],['unrelated']]);
  assert.deepEqual(revisionFamilies(items.slice(0,3)).map(f=>f.map(x=>x.id)),[['third','second'],['unrelated']]);
});
test('history filtering occurs before pagination and treats scheduled posts consistently',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'remix-filtered-history-'));
  const db=new WorkspaceDatabase(path.join(directory,'workspace.sqlite'));
  try {
    await db.initialize();
    const entries:ExportHistoryEntry[]=Array.from({length:75},(_,i)=>({id:String(i),jobId:String(i),sourceId:'source',sourceFingerprint:'hash',sourceName:'Original',title:`Clip ${i}`,createdAt:`2026-10-${i===70?'02':'01'}T10:00:00Z`,revision:1,cuts:[],stockShots:[],publications:[],sourceText:'',outputDuration:10,
      project:i%2?'Launch':'Archive',measurements:i%2?{review:{verdict:'accepted-unchanged'}}:undefined,
      configuration:{version:1,profileId:'profile',settings:{...DEFAULT_SETTINGS,aspect:'9:16'},actual:{captions:'off',narration:false,visualCount:0,visualCoveragePercent:0,visualSources:[]}}}));
    db.save({sources:[],attachments:[],jobs:[],broll:[]},entries);
    assert.equal(db.page({review:'accepted',limit:5}).total,37); assert.equal(db.page({review:'accepted',limit:5,offset:5}).entries.length,5);
    assert.equal(db.page({search:'launch'}).total,37); assert.equal(db.page({aspect:'16:9'}).total,0);
    assert.deepEqual(db.page({after:'2026-10-02',before:'2026-10-02'}).entries.map(e=>e.id),['70']);
    db.savePublishing('publication','post',{jobId:'1',state:'scheduled'});
    assert.equal(db.page({publication:'scheduled'}).total,1); assert.equal(db.page({publication:'unpublished'}).total,74);
    db.savePublishing('publication','published',{jobId:'1',state:'published'});
    assert.equal(db.page({publication:'scheduled'}).total,0); assert.equal(db.page({publication:'published'}).total,1);
    assert.deepEqual(db.projects(),['Archive','Launch']);
  } finally { db.close();await rm(directory,{recursive:true,force:true}); }
});
