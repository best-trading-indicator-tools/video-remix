import assert from "node:assert/strict";
import { test } from "node:test";
import { groundGraphicScenes, planGraphicScenes, type GraphicMoment } from "../server/graphic-planner.js";
import { graphicSceneSvg } from "../shared/graphic-art.js";
import type { GraphicScene } from "../shared/graphic-scene.js";

const quote = "Text someone good morning to feel connected.";
const moment: GraphicMoment = {start:4,end:7.6,text:quote,context:"Reach out to another person. You feel part of the tribe.",
 words:quote.split(" ").map((word,i)=>({word,start:4+i*.32,end:4+i*.32+.25}))};
const scene: GraphicScene = {kind:"process",title:"A small check-in",reason:"Connects a message with the speaker’s stated feeling of connection.",unit:"",nodes:[
 {label:"Morning message",icon:"phone",quote:"Text someone good morning",value:null,at:0},
 {label:"Feel connected",icon:"people",quote:"feel connected",value:null,at:0},
]};
const reply=(graphic=scene)=>({scenes:[{momentIndex:0,scene:graphic}]});

test("check-in diagram anchors to the current words and keeps the relationship, not the tribe metaphor",()=>{
 const result=groundGraphicScenes(reply(),[moment]).get(0)!;
 assert.equal(result.kind,"process");assert.deepEqual(result.nodes.map(node=>node.icon),["phone","people"]);
 assert.equal(result.nodes[0]!.at,0);assert.ok(Math.abs(result.nodes[1]!.at-1.6)<.01);
 assert.throws(()=>groundGraphicScenes(reply({...scene,nodes:[scene.nodes[0]!,{...scene.nodes[1]!,quote:"part of the tribe"}]}),[moment]),/verified/i);
 assert.throws(()=>groundGraphicScenes({scenes:[...reply().scenes,...reply().scenes]},[moment]));
 assert.throws(()=>groundGraphicScenes({scenes:[{momentIndex:99,scene}]},[moment]));
 assert.throws(()=>groundGraphicScenes(reply(),[{...moment,end:5.5}]));
});

test("data charts require exact same-unit quantities and labels, never invented percentages",()=>{
 const data: GraphicMoment={start:10,end:14,text:"Walking takes 20 minutes. Cycling takes 10 minutes."};
 const bars: GraphicScene={kind:"bars",title:"Travel time",reason:"Compares the two travel times stated in this sentence.",unit:"minutes",nodes:[
 {label:"Walking",icon:"person",quote:"Walking takes 20 minutes",value:20,at:0},
 {label:"Cycling",icon:"clock",quote:"Cycling takes 10 minutes",value:10,at:0},
 ]};
 assert.equal(groundGraphicScenes(reply(bars),[data]).get(0)?.nodes[0]?.value,20);
 for(const invalid of [{...bars,unit:"percent"},{...bars,nodes:[{...bars.nodes[0]!,value:80},bars.nodes[1]!]},{...bars,nodes:[{...bars.nodes[0]!,label:"Happiness"},bars.nodes[1]!]}])
  assert.throws(()=>groundGraphicScenes(reply(invalid),[data]),/verified/i);
 assert.throws(()=>groundGraphicScenes(reply(bars),[moment]),/verified/i);
 assert.throws(()=>groundGraphicScenes(reply({...bars,nodes:[{...bars.nodes[0]!,value:-1},bars.nodes[1]!]}),[data]));
});

test("planner uses bounded current speech and no text-only fallback when AI is unavailable",async()=>{
 let calls=0;
 const result=await planGraphicScenes({moments:[moment],signal:new AbortController().signal,configured:true,
  generate:async options=>{calls++;assert.ok(JSON.stringify(options.prompt).includes(moment.text));assert.match(options.system!,/neighboring context/);options.validate!(reply());return reply();}});
 assert.equal(calls,1);assert.equal(result.scenes.size,1);
 const off=await planGraphicScenes({moments:[moment],signal:new AbortController().signal,configured:false,generate:async()=>{assert.fail("No call without configuration");}});
 assert.equal(off.scenes.size,0);assert.match(off.notes.join(" "),/No generic text cards/);
 const bad=await planGraphicScenes({moments:[moment],signal:new AbortController().signal,configured:true,generate:async()=>({scenes:[{momentIndex:0,scene:{...scene,nodes:[{...scene.nodes[0]!,quote:"An invented claim"},scene.nodes[1]!]}}]})});
 assert.equal(bad.scenes.size,0);
 await assert.rejects(planGraphicScenes({moments:[moment],signal:AbortSignal.abort(),configured:true}),{name:"AbortError"});
});

test("both animation clocks draw bounded vector scenes and keep injected markup inert",()=>{
 const grounded=groundGraphicScenes(reply(),[moment]).get(0)!;
 const early=graphicSceneSvg(grounded,360,640,.2,"paper"),late=graphicSceneSvg(grounded,360,640,3,"paper");
 assert.notEqual(early,late);assert.match(early,/opacity="0"/);assert.match(late,/opacity="1"/);
 const html=graphicSceneSvg({...grounded,title:'<script>alert(1)</script>'},360,640);
 assert.ok(!html.includes("<script>"));assert.ok(html.includes("&lt;script&gt;"));
 assert.ok(!/\b(?:src|href)=/u.test(html));assert.match(html,/scene-reveal/);
 assert.match(html,/animation:scene-reveal .35s ease-out 1.6s/);
});


test("one unsupported proposal cannot discard another verified scene", async () => {
 const input = [moment, {...moment,start:10,end:13.6,words:moment.words!.map(word=>({...word,start:word.start+6,end:word.end+6}))}];
 const value={scenes:[...reply().scenes,{momentIndex:1,scene:{...scene,nodes:[{...scene.nodes[0]!,quote:"An invented promise"},scene.nodes[1]!]}}]};
 const result=await planGraphicScenes({moments:input,configured:true,signal:new AbortController().signal,generate:async()=>value});
 assert.deepEqual([...result.scenes.keys()],[0]);assert.match(result.notes.join(" "),/verified scenes were kept/);
 assert.throws(()=>groundGraphicScenes(reply(),[{...moment,end:6}]),/verified/i);
 const swapped={kind:"bars",title:"Travel time",reason:"Compares two times.",unit:"minutes",nodes:[
  {label:"Walking",icon:"person",quote:"Walking takes 20 minutes and cycling takes 10 minutes",value:10,at:0},
  {label:"Cycling",icon:"clock",quote:"Walking takes 20 minutes and cycling takes 10 minutes",value:20,at:0}]};
 assert.throws(()=>groundGraphicScenes(reply(swapped as GraphicScene),[{start:0,end:5,text:swapped.nodes[0]!.quote}]),/verified/i);
});
