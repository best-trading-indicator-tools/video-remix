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
