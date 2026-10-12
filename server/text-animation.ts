import { captionWordStarts, resolveCaptionStyle, type CaptionStyle } from '../shared/caption-style.js';
import { textAnimationTimes, textMotion, typewriterCount } from '../shared/text-animation.js';

export const assLiteral = (text: string) => text.replace(/\\/gu, '\\\u200b').replace(/\{/gu, '(').replace(/\}/gu, ')').replace(/\n/gu, '\\N');
const alpha = (opacity: number) => `&H${Math.round(255 * (1 - opacity)).toString(16).padStart(2, '0').toUpperCase()}&`;
export function assOpacity(opacity: number, backgroundOpacity = 1) {
  return `\\1a${alpha(opacity)}\\3a${alpha(opacity * backgroundOpacity)}\\4a${alpha(opacity)}`;
}

export function animatedTextFrames(text: string, original: string, style: CaptionStyle | undefined, start: number, end: number, words: { start: number; end: number; word: string }[] = []) {
  const s = resolveCaptionStyle(style), starts = captionWordStarts(original, start, end, words);
  const times = textAnimationTimes(s, text, start, end, starts);
  return times.slice(0, -1).map((time, index) => {
    let active = 0;
    starts.forEach((at, i) => { if (at <= time + .005) active = i; });
    return { start: time, end: times[index + 1]!, active, visible: s.animation === 'typewriter' ? typewriterCount(text, start, end, time + .005) : Infinity,
      ...textMotion(s, start, end, time) };
  });
}

/** Invisible characters retain their advance, keeping line breaks stable during reveals. */
export function animatedAssText(text: string, style: CaptionStyle | undefined, frame: { active: number; visible: number; opacity: number }, offset = 0, wordOffset = 0) {
  const s = resolveCaptionStyle(style);
  let character = offset, word = wordOffset - 1, previous = '';
  return text.split(/(\s+)/u).map(token => {
    const whitespace = /^\s+$/u.test(token);
    if (!whitespace && token) word++;
    return Array.from(token).map(char => {
      const shown = character++ < frame.visible && (s.animation !== 'words' || word <= frame.active);
      const color = s.wordHighlight && word === frame.active && !whitespace ? s.highlightColor : s.color;
      const bgr = `&H${color.slice(5, 7)}${color.slice(3, 5)}${color.slice(1, 3)}&`;
      const tags = `${assOpacity(shown ? frame.opacity : 0, s.background === 'box' ? s.backgroundOpacity / 100 : 1)}\\1c${bgr}`;
      const prefix = tags === previous ? '' : `{${tags}}`;
      previous = tags;
      return prefix + assLiteral(char);
    }).join('');
  }).join('');
}
