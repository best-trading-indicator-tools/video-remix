import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DraftWriter, draftKey, parseDraft, type SavedDraft } from '../src/result-drafts.js';
import type { apiRequest } from '../src/api-client.js';
import { DEFAULT_SETTINGS, type EditPlan } from '../shared/types.js';
const plan: EditPlan = { version:1, revision:1, sourceId:'source', sourceDuration:10, outputDuration:10, createdAt:'2026-10-01', settings:{...DEFAULT_SETTINGS}, cuts:[{start:0,end:10}],captions:[],visuals:[],media:[],narration:false };
const content = JSON.stringify({draft:plan,refreshBroll:false,brollCount:3,brollMaxCoverage:50,promptAnchor:null,reviewTime:3});
const saved: SavedDraft = {revision:1,content,savedAt:'2026-10-01',token:'first'};
const memory = () => { const data = new Map<string,string>(); return { data, setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);} }; };
test('restoring drafts rejects stale revisions and other source videos',()=>{
  assert.equal(parseDraft(content,plan)?.reviewTime,3);
  assert.equal(parseDraft(content,{...plan,revision:2}),null);
  assert.equal(parseDraft(content,{...plan,sourceId:'other'}),null);
  assert.equal(parseDraft('invalid',plan),null);
});
test('autosave serializes writes and preserves a reset queued during an in-flight save',async()=>{
  const storage=memory(),calls: {method?:string;token?:string}[]=[];
  let release!:()=>void;
  const gate = new Promise<void>(resolve=>{release=resolve;});
  const request = (async (_url:string,init?:RequestInit)=>{ calls.push({method:init?.method,token:init?.body ? JSON.parse(String(init.body)).token : (init?.headers as Record<string,string>)?.['If-Match']}); if(init?.method==='PUT') {await gate;return {draft:{...saved,token:'second'}};} return {ok:true};}) as typeof apiRequest;
  const writer=new DraftWriter('job',1,null,()=>{},storage,request);
  writer.schedule(content); const flushing=writer.flush(); writer.schedule(null);
  assert.equal(JSON.parse(storage.data.get(draftKey('job'))!).content,null,'reset is backed up until server acknowledges it');
  release(); await flushing;
  assert.deepEqual(calls,[{method:'PUT',token:null},{method:'DELETE',token:'second'}]); assert.equal(storage.data.size,0);
});
test('network failures retain the newest browser draft and retry with the last saved token',async()=>{
  const storage=memory(); let fail=true; const statuses:string[]=[];
  const request=(async()=>{if(fail)throw new Error('offline');return {draft:{...saved,token:'next'}};}) as typeof apiRequest;
  const writer=new DraftWriter('job',1,saved,message=>statuses.push(message),storage,request);
  writer.schedule('newest'); await writer.flush(); assert.equal(writer.localSafe,true); assert.equal(JSON.parse(storage.data.get(draftKey('job'))!).content,'newest');
  assert.match(statuses.at(-1)!,/Browser backup saved/); fail=false; await writer.flush(); assert.equal(storage.data.size,0);
});
test('storage and server failure make closing unsafe until a server save succeeds',async()=>{
  let fail=true; const storage={setItem:()=>{throw new Error('quota');},removeItem:()=>{throw new Error('quota');}};
  const request=(async()=>{if(fail)throw new Error('offline');return {draft:saved};}) as typeof apiRequest;
  const writer=new DraftWriter('job',1,null,()=>{},storage,request); writer.schedule(content); await writer.flush(); assert.equal(writer.localSafe,false);
  fail=false; await writer.flush(); assert.equal(writer.localSafe,true);
});
test('reset during a save remains unsafe when its browser backup cannot be written',async()=>{
  const storage=memory(); let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const request=(async(_url:string,init?:RequestInit)=>{if(init?.method==='PUT'){await gate;return {draft:saved};}return {ok:true};}) as typeof apiRequest;
  const writer=new DraftWriter('job',1,null,()=>{},storage,request);
  writer.schedule(content);const flushing=writer.flush();
  storage.setItem=()=>{throw new Error('quota');};writer.schedule(null);assert.equal(writer.localSafe,false);
  release();await flushing;assert.equal(writer.localSafe,true);await writer.flush();
});
