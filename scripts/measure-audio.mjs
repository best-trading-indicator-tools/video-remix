// Print what Auto would hear in a media file, and which sound look it would
// choose, without queueing a job. Usage:
//   node --import tsx scripts/measure-audio.mjs <file> [more files...]
import path from "node:path";
import { analyzeAudio } from "../server/audio-analysis.ts";
import { AUDIO_LOOKS, AUDIO_LOOK_KEYS, audioLookCost, audioTargets, chooseAudioLook } from "../shared/audio.ts";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node --import tsx scripts/measure-audio.mjs <file> [more files...]");
  process.exit(1);
}
const decibels = (value) => `${value.toFixed(1).padStart(6)} dB`;
const amount = (value) => value.toFixed(2).padStart(6);

for (const file of files) {
  const analysis = await analyzeAudio(path.resolve(file), {});
  console.log(`\n${path.basename(file)}`);
  if (!analysis) {
    console.log("  no measurable audio; Auto would leave the sound untouched");
    continue;
  }
  console.log(`  windows   quiet ${decibels(analysis.quietDb)}   median ${decibels(analysis.medianDb)}   loud ${decibels(analysis.loudDb)}`);
  console.log(`  noise floor below speech ${decibels(analysis.loudDb - analysis.quietDb)}, loud-to-median spread ${decibels(analysis.loudDb - analysis.medianDb)}`);
  console.log(`  bands     low ${decibels(analysis.lowDb)}   body ${decibels(analysis.bodyDb)}   presence ${decibels(analysis.presenceDb)}   air ${decibels(analysis.airDb)}   (relative to full band)`);
  const targets = audioTargets(analysis);
  console.log(`  asks for  ${AUDIO_LOOK_KEYS.map((key) => `${key} ${amount(targets[key])}`).join("  ")}`);
  const ranked = AUDIO_LOOKS.filter((look) => look.automatic)
    .map((look) => [look, audioLookCost(look, targets)])
    .sort((first, second) => first[1] - second[1]);
  console.log(`  ranked    ${ranked.map(([look, cost]) => `${look.name} ${cost.toFixed(2)}`).join("  ·  ")}`);
  const choice = chooseAudioLook(analysis);
  console.log(`  chooses   ${choice.name} — ${choice.reason}`);
}
