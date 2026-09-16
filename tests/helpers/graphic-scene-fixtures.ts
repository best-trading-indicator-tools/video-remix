import type { GraphicScene } from "../../shared/graphic-scene.js";
export const sceneFixtures: GraphicScene[] = [
 {kind:"process",title:"A small check-in",reason:"Shows the link between sending a message and feeling connected, as stated in the speech.",unit:"",nodes:[
  {label:"Morning message",icon:"phone",quote:"Text someone good morning",value:null,at:0},
  {label:"Feel connected",icon:"people",quote:"feel connected",value:null,at:1.2}]},
 {kind:"bars",title:"Same journey. Different time.",reason:"Compares the two travel times in the example transcript.",unit:"minutes",nodes:[
  {label:"Walking",icon:"person",quote:"Walking takes 20 minutes",value:20,at:0},
  {label:"Cycling",icon:"clock",quote:"Cycling takes 10 minutes",value:10,at:1.2}]},
 {kind:"comparison",title:"Choose where attention goes",reason:"Illustrates the two alternatives described by the speaker.",unit:"",nodes:[
  {label:"Morning sunlight",icon:"sun",quote:"Choose morning sunlight",value:null,at:0},
  {label:"Phone screen",icon:"phone",quote:"instead of a phone screen",value:null,at:1.2}]},
 {kind:"illustration",title:"A message that matters",reason:"Depicts a morning message to another person.",unit:"",nodes:[
  {label:"Good morning",icon:"message",quote:"Send a good morning message",value:null,at:0}]},
];
