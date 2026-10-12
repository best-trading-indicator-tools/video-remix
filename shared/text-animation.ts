import type { CaptionStyle } from './caption-style.js';

export const TEXT_ANIMATIONS = [
  { id: 'none', label: 'None' }, { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' }, { id: 'slide', label: 'Slide up' },
  { id: 'typewriter', label: 'Typewriter' }, { id: 'words', label: 'Word by word' },
] as const;
export type TextAnimation = typeof TEXT_ANIMATIONS[number]['id'];

/** Both preview and export evaluate the video clock, so seeking never restarts an animation. */
export function textMotion(style: CaptionStyle | undefined, start: number, end: number, time: number) {
  const animation = style?.animation ?? 'none';
  const duration = Math.min(style?.animationDuration ?? .3, Math.max(.01, (end - start) / 2));
  const enter = Math.max(0, Math.min(1, (time - start) / duration));
  const leave = Math.max(0, Math.min(1, (end - time) / duration));
  const eased = 1 - (1 - enter) ** 3;
  return {
    opacity: ['fade', 'pop', 'slide'].includes(animation) ? Math.min(enter, leave) : 1,
    scale: animation === 'pop' ? .82 + .18 * eased : 1,
    y: animation === 'slide' ? 12 * (1 - eased) : 0,
  };
}

const typewriterDuration = (count: number, start: number, end: number) => Math.min(2, Math.max(.1, (end - start) * .7), Math.max(.3, count * .04));
export function typewriterCount(text: string, start: number, end: number, time: number) {
  const count = Array.from(text).length;
  const duration = typewriterDuration(count, start, end);
  return Math.min(count, Math.max(0, Math.floor((time - start) / duration * count) + 1));
}

/** Only moving sections need samples; long static captions do not grow the ASS file. */
export function textAnimationTimes(style: CaptionStyle | undefined, text: string, start: number, end: number, wordStarts: number[] = []) {
  const animation = style?.animation ?? 'none', times = [start, end];
  if (style?.wordHighlight || animation === 'words') times.push(...wordStarts);
  if (animation === 'typewriter') {
    const count = Array.from(text).length;
    const duration = typewriterDuration(count, start, end);
    for (let offset = 0; offset < duration; offset += 1 / 30) times.push(start + offset);
    times.push(start + duration);
  } else if (['fade', 'pop', 'slide'].includes(animation)) {
    const duration = Math.min(style?.animationDuration ?? .3, (end - start) / 2);
    for (let offset = 0; offset < duration; offset += 1 / 30) times.push(start + offset, end - offset);
    times.push(start + duration, end - duration);
  }
  return [...new Set(times.map(t => Math.round(Math.max(start, Math.min(end, t)) * 100)))].sort((a, b) => a - b).map(t => t / 100);
}
