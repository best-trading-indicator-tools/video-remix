import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captionWordStarts, DEFAULT_CAPTION_STYLE } from '../shared/caption-style.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { burnOutputCaptions, renderVideo, probeMedia } from '../server/engine.js';
const words = [{word:'ONE',start:0,end:0.2,probability:1},{word:'TWO',start:0.9,end:1.2,probability:1},{word:'THREE',start:1.4,end:2,probability:1}];
test('recognized words keep exact timing, while changed wording and SRT use bounded estimates', () => {
  assert.deepEqual(captionWordStarts('one two three!',0,2,words),[0,0.9,1.4]);
  const fallback = captionWordStarts('red green blue',0,2,words);
  assert.notDeepEqual(fallback,[0,0.9,1.4]); assert.equal(fallback[0],0); assert.ok(fallback.every((time,i)=>time<2 && (!i || time>fallback[i-1]!)));
});
test('word highlighting moves across actual MP4 pixels in exports, final captions and imported SRT', {timeout:30000}, async () => {
  const exec = promisify(execFile), dir = await mkdtemp(path.join(tmpdir(),'word-caption-test-'));
  const ffmpeg = (...args: string[]) => exec('ffmpeg',['-v','error','-nostdin','-y',...args],{encoding:'buffer',maxBuffer:8*1024*1024});
  try {
    const input = path.join(dir,'source.mp4'), subtitlePath = path.join(dir,'captions.srt');
    await ffmpeg('-f','lavfi','-i','color=black:s=640x360:r=24:d=2.2','-c:v','libx264','-threads','1',input);
    await writeFile(subtitlePath,'1\n00:00:00,000 --> 00:00:02,000\nONE TWO THREE\n');
    const source = await probeMedia(input), style = {...DEFAULT_CAPTION_STYLE,wordHighlight:true,fontSize:28,fontFamily:'tiktok-sans' as const,cyrillicMode:'words' as const,cyrillicWords:['ONE','THREE']};
    for (const mode of ['render','caption-pass','uploaded-srt']) {
      const output = path.join(dir,`${mode}.mp4`), common = {input,output,subtitlePath,workDir:dir,signal:new AbortController().signal};
      if (mode === 'caption-pass') await burnOutputCaptions({...common,style,words});
      else await renderVideo({...common,source,settings:{...DEFAULT_SETTINGS,captionStyle:style},captionWords:mode==='render'?words:undefined,onProgress() {}});
      const positions = [];
      for (const time of mode === 'uploaded-srt' ? [0.1,0.9,1.8] : [0.4,1.1,1.7]) {
        const pixels = (await ffmpeg('-ss',String(time),'-i',output,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1')).stdout;
        let yellow = 0, sumX = 0;
        for (let i=0;i<pixels.length;i+=3) if(pixels[i]!>170 && pixels[i+1]!>150 && pixels[i+2]!<130){yellow++;sumX+=(i/3)%source.width;}
        assert.ok(yellow>20,`${mode}: visible highlight`); positions.push(sumX/yellow);
      }
      assert.ok(positions[0]!<positions[1]! && positions[1]!<positions[2]!,`${mode}: highlight moves word by word`);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('plain SRT exports draw Cyrillic spelling without modifying the original caption file', {timeout:30000}, async () => {
  const exec = promisify(execFile), dir = await mkdtemp(path.join(tmpdir(),'cyrillic-caption-test-'));
  const ffmpeg = (...args: string[]) => exec('ffmpeg',['-v','error','-nostdin','-y',...args],{encoding:'buffer',maxBuffer:8*1024*1024});
  try {
    const input = path.join(dir,'source.mp4'), subtitlePath = path.join(dir,'captions.srt'), expectedPath = path.join(dir,'expected.srt');
    const original = '1\n00:00:00,000 --> 00:00:01,000\nSample-12 comes next\n';
    await ffmpeg('-f','lavfi','-i','color=black:s=640x360:r=24:d=1','-c:v','libx264','-threads','1',input);
    await writeFile(subtitlePath, original);
    await writeFile(expectedPath, '1\n00:00:00,000 --> 00:00:01,000\nЅаmрlе-12 comes next\n');
    const source = await probeMedia(input), base = {...DEFAULT_CAPTION_STYLE,fontFamily:'tiktok-sans' as const,fontSize:28};
    const style = {...base,cyrillicMode:'words' as const,cyrillicWords:['Sample-12']};
    for (const mode of ['render','caption-pass']) {
      const pixels: Buffer[] = [];
      for (const reference of [false,true]) {
        const output = path.join(dir,`${mode}-${reference}.mp4`);
        const common = {input,output,subtitlePath:reference?expectedPath:subtitlePath,workDir:dir,signal:new AbortController().signal};
        if (mode === 'caption-pass') await burnOutputCaptions({...common,style:reference?base:style});
        else await renderVideo({...common,source,settings:{...DEFAULT_SETTINGS,captionStyle:reference?base:style},onProgress() {}});
        pixels.push((await ffmpeg('-ss','0.4','-i',output,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1')).stdout);
      }
      assert.ok(pixels[0]!.some(value=>value>150), `${mode}: visible captions`);
      assert.deepEqual(pixels[0],pixels[1],`${mode}: matches literal Cyrillic reference`);
    }
    assert.equal(await readFile(subtitlePath,'utf8'),original);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
