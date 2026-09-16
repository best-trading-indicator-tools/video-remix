import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeMedia } from "../server/engine.js";
import { graphicsAvailable, renderGraphic } from "../server/visuals.js";
import { remotionAvailable, renderRemotionGraphic } from "../server/remotion-visuals.js";
import { sceneFixtures } from "./helpers/graphic-scene-fixtures.js";
const exec=promisify(execFile);
const frame=async(file:string,time:number)=>(await exec("ffmpeg",["-v","error","-ss",String(time),"-i",file,"-frames:v","1","-vf","scale=180:320","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],{encoding:"buffer"})).stdout;

test("both engines render a spoken diagram and chart with delayed second elements and a clear caption rail",{timeout:180000},async t=>{
 if(!await graphicsAvailable()||!await remotionAvailable()) {if(process.env.REQUIRE_GRAPHICS_TESTS==="true") assert.fail("Install graphics browsers"); t.skip();return;}
 const dir=await mkdtemp(path.join(os.tmpdir(),"graphic-scenes-"));
 try {
  for(const [engine,render] of [["hyperframes",renderGraphic],["remotion",renderRemotionGraphic]] as const) {
   for(const scene of sceneFixtures.slice(0,2)) {
    const output=path.join(dir,`${engine}-${scene.kind}.mp4`);
    await render({scene,text:scene.title,width:360,height:640,duration:3,output,workDir:dir,signal:AbortSignal.timeout(45000)});
    const info=await probeMedia(output);
    assert.deepEqual([info.width,info.height,info.hasAudio],[360,640,false]);assert.ok(Math.abs(info.duration-3)<.08);
    const early=await frame(output,.7),late=await frame(output,2.5);
    let revealed=0,rail=0;
    for(let y=165;y<220;y++)for(let x=20;x<160;x++){
     const i=(y*180+x)*3;if(Math.abs(early[i]!-late[i]!)+Math.abs(early[i+1]!-late[i+1]!)+Math.abs(early[i+2]!-late[i+2]!)>35)revealed++;
    }
    for(let y=255;y<315;y++)for(let x=20;x<160;x++){
     const i=(y*180+x)*3;rail+=Math.abs(late[i]!-late[(310*180+10)*3]!);
    }
    assert.ok(revealed>150,`${engine}/${scene.kind} must reveal its second element at its speech cue (${revealed})`);
    assert.ok(rail/(60*140)<3,`${engine}/${scene.kind} must keep the lower caption rail clear`);
   }
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
