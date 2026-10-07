import { useState } from 'react';
import { apiRequest } from './api-client';
import type { AutoOptions, RemixSettings } from '../shared/types';
import PromptEditor, { type ReviewablePrompt } from './PromptEditor';

type AutoDraft = { options: AutoOptions; variants: number };
interface AutoProposal extends AutoDraft, ReviewablePrompt { manual?: RemixSettings }
// The server schema and preference normalizer order object keys differently.
const identityOf = (value: AutoDraft) => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

const examples = [
  { label: 'Captions & bands', prompt: 'Add bold yellow captions and black bands above and below the picture.' },
  { label: 'Add B-roll', prompt: 'Add 4 relevant B-roll shots, covering at most 50% of the video.' },
  { label: 'Animated visuals', prompt: 'Add supporting animations using Remotion.' },
  { label: 'Keep the full video', prompt: 'Keep the full video and its original voice.' },
  { label: 'Three short clips', prompt: 'Make up to 3 different moments, each at most 30 seconds, in portrait 9:16.' },
  { label: 'Tighter pacing', prompt: 'Use tighter pacing and remove isolated filler words.' },
  { label: 'Podcast sound', prompt: 'Use the podcast sound look.' },
  { label: 'New angles', prompt: 'Make 4 short versions with new angles on the same moment.' },
];
export default function AutoPromptEditor({ sourceId, options, variants, disabled, onApply, onSwitchManual }: AutoDraft & {
  sourceId: string; disabled?: boolean; onApply: (value: AutoDraft) => void; onSwitchManual: (settings: RemixSettings) => void;
}) {
  const [undo, setUndo] = useState<{ draft: AutoDraft; identity: string } | null>(null);
  const identity = identityOf({ options, variants });
  return <div className="auto-prompt-editor"><PromptEditor<AutoProposal> title="Remix with a prompt" contextKey={`${sourceId}:${identity}`} disabled={disabled}
    description="Describe a remix for the selected video."
    placeholder="e.g. Add captions, black bands and 4 B-roll shots"
    scope="Length, versions, captions, black bands, B-roll, animations, uploaded footage, pacing, sound and review settings. Edits needing Manual include a workspace switch in the proposal. Review changes before rendering."
    examples={examples} onSuggest={(prompt, signal) => apiRequest(`/api/sources/${sourceId}/auto-prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, options, variants }), signal,
    })} onApply={proposal => {
      if (proposal.manual) { onSwitchManual(proposal.manual); return; }
      const next = structuredClone({ options: proposal.options, variants: proposal.variants });
      setUndo({ draft: structuredClone({ options, variants }), identity: identityOf(next) }); onApply(next);
    }} applied={!!undo} canUndo={undo?.identity === identity} onUndo={() => {
      if (undo?.identity === identity) { onApply(structuredClone(undo.draft)); setUndo(null); }
    }} appliedMessage="Settings applied to this video. Start Auto remix when ready."
    undoBlockedMessage="Your newer settings are kept. Undo is available while the prompt is the latest edit." /></div>;
}
