import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceAtTime, splitTimelineCut, shiftTimelineInterval } from '../shared/edit-timeline.js';
import { applyEditPlanChanges } from '../server/edit-plan.js';
import { DEFAULT_SETTINGS, type EditPlan } from '../shared/types.js';
const plan: EditPlan = { version: 1, revision: 1, sourceId: 'source', sourceDuration: 20, outputDuration: 10, createdAt: new Date().toISOString(), settings: { ...DEFAULT_SETTINGS, hookText: 'Hello' }, cuts: [{start: 5,end: 15}], captions: [], visuals: [], media: [{id: 'clip',name: 'Saved clip',kind: 'broll',duration: 4}], narration: false };
test('timeline seeking and splitting respect reordered source cuts and speed', () => {
  const cuts = [{start: 10,end: 14},{start: 2,end: 6}];
  assert.deepEqual(sourceAtTime(cuts,2,2.5),{index: 1,time: 3});
  assert.deepEqual(splitTimelineCut(cuts,2,2.5),[cuts[0],{start: 2,end: 3},{start: 3,end: 6}]);
  assert.throws(() => splitTimelineCut(cuts,2,2),/inside a cut/);
});
test('timeline gestures stay inside neighboring clips and available media', () => {
  const bounds = {low: 2,high: 8,minimum: 0.5,maxLength: 3};
  assert.deepEqual(shiftTimelineInterval({start:3,end:5},10,'move',bounds),{start:6,end:8});
  assert.deepEqual(shiftTimelineInterval({start:3,end:5},-10,'start',bounds),{start:2,end:5});
  assert.deepEqual(shiftTimelineInterval({start:3,end:5},10,'end',bounds),{start:3,end:6});
});
test('timeline changes persist hook timing, add retained footage, and protect locked shots', () => {
  const shot = {id: 'new-shot',mediaId: 'clip',start:2,end:4,sourceStart:0,enabled:true,locked:false};
  const next = applyEditPlanChanges(plan,{revision:1,hookDuration:2,visuals:[shot]});
  assert.equal(next.settings.hookDuration,2); assert.deepEqual(next.visuals,[shot]);
  assert.equal(plan.visuals.length,0);
  assert.throws(() => applyEditPlanChanges(plan,{revision:1,visuals:[{...shot,mediaId:'unknown'}]}),/already saved/);
  const locked = {...next,visuals:[{...shot,locked:true}]};
  assert.throws(() => applyEditPlanChanges(locked,{revision:2,visuals:[{...shot,start:3,end:5,locked:true}]}),/Unlock/);
  const recut = applyEditPlanChanges({...plan,captionWords:[{word:'Hello',start:2,end:2.5,probability:1}]},{revision:1,cuts:[{start:6,end:15}]});
  assert.deepEqual(recut.captionWords?.map(({start,end})=>({start,end})),[{start:1,end:1.5}]);
});

test('full storyline includes inserts and outros, with reversible clocks', async () => {
  const { storyClips, storyTiming, storyChanges, mainTimeAt, outputTimeAt } = await import('../shared/edit-timeline.js');
  const inserted = { id:'c931b7ec-bbaa-4168-95c5-c8720547f6cd',assetId:'a931b7ec-bbaa-4168-95c5-c8720547f6cd',at:3,start:1,end:3,mode:'insert' as const,audio:'clip' as const,fit:'contain' as const };
  const outro = {...inserted,id:'d931b7ec-bbaa-4168-95c5-c8720547f6cd',appendToEnd:true,at:0,start:0,end:8};
  const input = {...plan,settings:{...plan.settings,ownFootage:[inserted,outro]}};
  const clips = storyClips(input), timed = storyTiming(clips,1);
  assert.deepEqual(timed.map(clip => [clip.kind,clip.outputStart,clip.outputEnd]),[['cut',0,3],['footage',3,5],['cut',5,12],['footage',12,20]]);
  assert.equal(mainTimeAt(clips,1,4),3); assert.equal(mainTimeAt(clips,1,7),5);
  assert.equal(outputTimeAt(clips,1,3),5); assert.equal(outputTimeAt(clips,1,3,'end'),3);
  const changed = storyChanges(clips,input);
  assert.deepEqual(changed.cuts,[{start:5,end:8},{start:8,end:15}]);
  assert.equal(changed.ownFootage[1]?.at,10);
  assert.doesNotThrow(()=>applyEditPlanChanges(input,{revision:1,...changed}));
});

test('copy and paste a sequence into a clip preserves order, focus and source bounds', async () => {
  const { storyClips, storyChanges, pasteStory, splitStory } = await import('../shared/edit-timeline.js');
  const clips = storyClips(plan);
  const split = splitStory(clips,1,4,'split');
  let serial=0;
  const pasted = pasteStory(split,split.slice(0,1),1,7,()=>`copy-${++serial}`);
  assert.deepEqual(storyChanges(pasted,plan).cuts,[{start:5,end:9},{start:9,end:12},{start:5,end:9},{start:12,end:15}]);
  assert.equal(clips.length,1);
  assert.throws(()=>pasteStory(split,[split[0]!],1,4.01,()=>`copy-${++serial}`),/farther/);
  const fast = {...plan, settings:{...plan.settings,speed:2}};
  assert.deepEqual(storyChanges(splitStory(storyClips(fast),2,1,'split'),fast).cuts,[{start:5,end:7},{start:7,end:15}]);
  assert.throws(()=>storyChanges([],plan),/at least one/);
});

test('uploaded clips can be split, copied and reordered with independent placement IDs', async () => {
  const { storyClips, storyChanges, splitStory, pasteStory } = await import('../shared/edit-timeline.js');
  const { ownFootageSchema } = await import('../shared/own-footage.js');
  const { randomUUID } = await import('node:crypto');
  const placement = { id:randomUUID(),assetId:randomUUID(),at:0,start:0,end:4,appendToEnd:true,mode:'insert' as const,audio:'clip' as const,fit:'contain' as const };
  const input={...plan,settings:{...plan.settings,ownFootage:[placement]}};
  const split=splitStory(storyClips(input),1,12,randomUUID());
  const pasted=pasteStory(split,[split[2]!],1,0,randomUUID);
  const changes=storyChanges(pasted,input);
  assert.deepEqual(changes.ownFootage.map(item=>[item.at,item.start,item.end]),[[0,2,4],[10,0,2],[10,2,4]]);
  assert.equal(new Set(changes.ownFootage.map(item=>item.id)).size,3);
  assert.doesNotThrow(()=>ownFootageSchema.parse(changes.ownFootage));
});
