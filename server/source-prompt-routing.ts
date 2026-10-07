import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS, type AutoOptions, type RemixSettings } from '../shared/types.js';
import { audioLookById, activeAudioLook } from '../shared/audio.js';
import { proposeAutoPrompt } from './auto-prompt.js';
import { proposeManualPrompt } from './manual-prompt.js';
import type { PromptAssets } from './source-prompt-controls.js';

type Context = { source: { duration: number; width: number; height: number; hasAudio: boolean }; prompt: string; signal: AbortSignal; assets: PromptAssets };
function sharedOptions(value: AutoOptions | RemixSettings) {
  const { aspect, blackBands, captionStyle, ownFootage, visualSources, supportingVisuals, stockVideoType, brollIds, brollMatching, brollCount, brollMaxCoverage } = value;
  return { aspect, blackBands, captionStyle, ownFootage, visualSources, supportingVisuals, stockVideoType, brollIds, brollMatching, brollCount, brollMaxCoverage };
}
export async function sourcePromptProposal(context: Context, draft: { settings: RemixSettings } | { options: AutoOptions; variants: number }) {
  if ('settings' in draft) {
    const proposal = await proposeManualPrompt({ ...context, settings: draft.settings });
    if (!proposal.switchTo) return proposal;
    const options: AutoOptions = { ...DEFAULT_AUTO_OPTIONS, ...sharedOptions(draft.settings),
      captions: draft.settings.automaticCaptions === 'add' ? 'add' : draft.settings.automaticCaptions === 'auto' || draft.settings.subtitleId ? 'auto' : 'keep',
      audio: activeAudioLook(draft.settings) as AutoOptions['audio'] || 'auto' };
    const next = await proposeAutoPrompt({ ...context, options, variants: 1 });
    if (next.switchTo || next.clarification) return { settings: draft.settings, summary: [], clarification: next.clarification || 'This request combines Auto selection with precise Manual controls. Separate these steps: generate an Auto remix, then edit its result.' };
    return { settings: draft.settings, auto: { options: next.options, variants: next.variants },
      summary: ['Continue in Auto remix: Auto will choose the source cuts. Your Manual draft stays saved.', ...next.summary] };
  }
  const proposal = await proposeAutoPrompt({ ...context, ...draft });
  if (!proposal.switchTo) return proposal;
  const settings: RemixSettings = { ...DEFAULT_SETTINGS, ...sharedOptions(draft.options),
    ...(audioLookById(draft.options.audio || 'original')?.adjustments || {}),
    resolution: '1080', fps: '30', fit: 'blur',
    automaticCaptions: draft.options.captions === 'keep' ? 'off' : draft.options.captions === 'add' ? 'add' : 'auto' };
  const next = await proposeManualPrompt({ ...context, settings });
  if (next.switchTo || next.clarification) return { options: draft.options, variants: draft.variants, summary: [], clarification: next.clarification || 'This request combines Auto selection with precise Manual controls. Separate these steps: generate an Auto remix, then edit its result.' };
  return { options: draft.options, variants: draft.variants, manual: next.settings,
    summary: ['Continue in Manual: use the source and the cuts below for one export. Your Auto preferences stay saved.', ...next.summary] };
}
