import { useState } from 'react';
import { apiRequest } from './api-client';
import { suggestAutoBatch, type AutoBatchProposal, type AutoPromptTarget } from '../shared/auto-batch';
import PromptEditor from './PromptEditor';
// The server schema and preference normalizer order object keys differently.
const identityOf = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

const examples = [
  { label: "AI upscale to 4K", prompt: "Upscale to 4K with the free local AI upscaler. Keep all other settings." },
  { label: 'Captions & bands', prompt: 'Add bold yellow captions and black bands above and below the picture.' },
  { label: 'Upper-band text', prompt: 'Add "YOUR TITLE" in Cyrillic lookalikes, white, medium size, in the upper black band.' },
  { label: 'Add my ending clip', prompt: 'Append my uploaded ending clip in full after each video, keeping its audio. Ask me to name the clip if more than one could match.' },
  { label: 'Add B-roll', prompt: 'Add 4 relevant B-roll shots, covering at most 50% of the video.' },
  { label: 'Animated visuals', prompt: 'Add supporting animations using Remotion.' },
  { label: 'Keep the full video', prompt: 'Keep the full video and its original voice.' },
  { label: 'Three short clips', prompt: 'Make up to 3 different moments, each at most 30 seconds, in portrait 9:16.' },
  { label: 'Tighter pacing', prompt: 'Use tighter pacing and remove isolated filler words.' },
  { label: 'Podcast sound', prompt: 'Use the podcast sound look.' },
  { label: 'New angles', prompt: 'Make 4 short versions with new angles on the same moment.' },
];
export default function AutoPromptEditor({ targets, scopeKey, disabled, onApply, onUndo, canUndo, appliedCount }: {
  targets: AutoPromptTarget[]; scopeKey: string; disabled?: boolean;
  onApply: (value: AutoBatchProposal) => void; onUndo: () => void; canUndo: boolean; appliedCount: number;
}) {
  const [completed, setCompleted] = useState(0);
  return <div className="auto-prompt-editor">
    {!!targets.length && <details className="auto-prompt-targets"><summary>Prompt targets: {targets.length} video{targets.length === 1 ? '' : 's'}</summary><ul>{targets.map(target => <li key={target.id}>{target.name}</li>)}</ul></details>}
    <PromptEditor<AutoBatchProposal> title="Remix with a prompt" contextKey={`${scopeKey}:${identityOf(targets)}`} disabled={disabled || !targets.length}
    description={targets.length ? `Describe changes for ${targets.length === 1 ? targets[0]!.name : `all ${targets.length} target videos`}. Review each video's proposal before applying.` : 'Check videos in the source list, or change Apply changes to.'}
    placeholder="e.g. Add black bands and append outro.mp4 in full to every target video"
    scope="AI upscaling, Length, versions, captions, black bands, B-roll, uploaded footage, pacing, sound and reviews. Each video keeps its unrelated settings. Prompts change the listed videos only; future import defaults stay unchanged. Edits needing Manual include a workspace switch in the proposal."
    examples={examples} onSuggest={(prompt, signal) => {
      setCompleted(0);
      return suggestAutoBatch(targets, prompt, signal, (target, text, requestSignal) => apiRequest(`/api/sources/${target.id}/auto-prompt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, ...target.draft }), signal: requestSignal,
      }), setCompleted);
    }} onApply={onApply} applied={!!appliedCount} canUndo={canUndo} onUndo={onUndo}
    applyLabel={`Apply to ${targets.length} video${targets.length === 1 ? '' : 's'}`}
    loadingMessage={`Preparing proposals: ${completed} of ${targets.length} videos…`}
    appliedMessage={`Prompt applied to ${appliedCount} video${appliedCount === 1 ? '' : 's'}. Start Auto remix when ready.`}
    undoBlockedMessage="Your newer settings are kept. Undo is available while the prompt is the latest edit." /></div>;
}
