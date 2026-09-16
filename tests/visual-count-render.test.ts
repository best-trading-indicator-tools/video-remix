import { fixtureGraphics } from "./helpers/graphic-scenes.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareSupportingVisuals } from "../server/supporting-plan.js";
import { probeMedia, renderVideo } from "../server/engine.js";
import { DEFAULT_SETTINGS, type Transcript } from "../shared/types.js";
import type { StoredJob, StoredSource } from "../server/store.js";
const exec = promisify(execFile);

test("four requested mixed cards are present in the decoded final ten-second video with source audio", {timeout:120000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "four-visuals-render-"));
  const signal = AbortSignal.timeout(110000);
  try {
    const input = path.join(directory, "source.mp4"), output = path.join(directory, "result.mp4");
    await exec("ffmpeg", ["-v","error","-y","-f","lavfi","-i","color=c=green:s=180x320:r=24:d=10","-f","lavfi","-i","sine=frequency=440:duration=10","-c:v","libx264","-threads","1","-pix_fmt","yuv420p","-c:a","aac","-shortest",input]);
    const metadata = await probeMedia(input);
    const source = {...metadata,id:"authored-source",name:"Camera advice",filePath:input} as StoredSource;
    const job = {id:"four-cards",settings:{...DEFAULT_SETTINGS,aspect:"original",resolution:"source",trimEnd:10},
      auto:{aspect:"9:16",targetDuration:10,narration:false,visualSources:["hyperframes","remotion"],brollCount:4},
      summary:{title:"Camera advice",sourceDuration:10,outputDuration:10,changes:[],usedAI:false,narration:false,transcriptAvailable:true}} as StoredJob;
    const transcript: Transcript = {language:"en",duration:10,segments:["Use soft window light.","Steady the camera tripod.","Check your audio microphone.","Frame the subject carefully."].map((text,i)=>({start:i*2.4,end:i*2.4+2.1,text,words:[]}))};
    const visuals = await prepareSupportingVisuals({planGraphics:fixtureGraphics,source,job,transcript,assets:[],workDir:directory,signal,onPhase:()=>{}});
    assert.equal(visuals.length,4,JSON.stringify(job.notes));
    assert.equal(new Set(visuals.map(visual=>visual.path)).size,4);
    assert.deepEqual(new Set(visuals.map(visual=>visual.visualSource)),new Set(["hyperframes","remotion"]));
    for(const visual of visuals)assert.ok((await stat(visual.path)).size>500);
    await renderVideo({input,output,source:metadata,settings:job.settings,supportingVisuals:visuals,workDir:directory,signal,onProgress:()=>{}});
    const rendered=await probeMedia(output);
    assert.ok(Math.abs(rendered.duration-10)<0.1); assert.equal(rendered.hasAudio,true);
    const frame=async(file:string,time:number)=>(await exec("ffmpeg",["-v","error","-ss",String(time),"-i",file,"-frames:v","1","-vf","scale=16:16","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],{encoding:"buffer"})).stdout;
    const original=await frame(input,1);
    for(const visual of visuals){
      const actual=await frame(output,visual.start+(visual.end-visual.start)*0.6);
      assert.equal(actual.length,original.length);
      const difference=actual.reduce((sum,value,i)=>sum+Math.abs(value-original[i]!),0)/actual.length;
      assert.ok(difference>20,`The ${visual.visualSource} placement at ${visual.start}s must replace the source picture (${difference})`);
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});
