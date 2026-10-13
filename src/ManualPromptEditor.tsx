import { workspaceHistory, useWorkspaceHistory } from "./workspace-history";
import { apiRequest } from "./api-client";
import { useState } from "react";
import { suggestManualBatch, type ManualBatchProposal, type ManualPromptTarget } from "../shared/manual-batch";
import PromptEditor, { type PromptExample } from "./PromptEditor";
const examples: PromptExample[] = [
  { label: 'Animated title', prompt: 'Add a Bold hook title saying "YOUR TITLE" for the first 3 seconds, with Pop animation.' },
  { label: 'Caption animation', prompt: 'Make added captions appear word by word.' },
  { label: 'Correct captions', prompt: 'Replace "acme" with "ACME" in all added captions.' },
  { label: "AI upscale to 4K", prompt: "Upscale to 4K with the free local AI upscaler. Keep all other settings." },
  { label: "Add captions", prompt: "Add automatic captions in bold yellow Poppins." },
  { label: "Black bands", prompt: "Add black bands above and below the video, keeping the whole picture." },
  { label: "Add B-roll", prompt: "Add 4 relevant B-roll shots, covering at most 50% of the video." },
  { label: "Animated visuals", prompt: "Add supporting animations using Remotion." },
  { label: "Warmer, more contrast", prompt: "Make the colors a little warmer with more contrast." },
  { label: "Portrait, 1080p", prompt: "Use 9:16 at 1080p. Keep the whole picture with a blurred background." },
  { label: "Faster pace", prompt: "Set playback speed to 1.15x." },
  { label: "Black & white", prompt: "Make the video black and white." },
  { label: "Clean up image", prompt: "Enable local video cleanup with mild denoising and sharpening." },
  { label: "Mute audio", prompt: "Mute the audio." },
  { label: "Mirror picture", prompt: "Flip the picture horizontally." },
  { label: "Add a title", prompt: "Show the opening title 'Here's the key idea' for 3 seconds." },
];

/** Proposals use the same current/checked/all working set as the controls. */
export default function ManualPromptEditor({ targets, scopeKey, disabled = false, onApply }: {
  targets: ManualPromptTarget[]; scopeKey: string; disabled?: boolean;
  onApply: (proposal: ManualBatchProposal) => void;
}) {
  const history = useWorkspaceHistory();
  const [appliedId, setAppliedId] = useState<number>();
  const [completed, setCompleted] = useState(0);
  return <div className="manual-prompt-editor">
    {!!targets.length && <details className="auto-prompt-targets"><summary>Prompt targets: {targets.length} video{targets.length === 1 ? '' : 's'}</summary><ul>{targets.map(target => <li key={target.id}>{target.name}</li>)}</ul></details>}
    <PromptEditor<ManualBatchProposal> contextKey={`${scopeKey}:${JSON.stringify(targets)}`} disabled={disabled || !targets.length}
      onSuggest={(prompt, signal) => {
        setCompleted(0);
        return suggestManualBatch(targets, prompt, signal, (target, text, requestSignal) => apiRequest(`/api/sources/${target.id}/edit-prompt`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: requestSignal, body: JSON.stringify({ prompt: text, settings: target.settings }),
        }), setCompleted);
      }} onApply={proposal => { workspaceHistory.label("Apply prompt to videos"); onApply(proposal); setAppliedId(history.undoId); }}
      examples={examples} placeholder="e.g. Set speed to 1.25x and flip horizontally"
      description={targets.length ? `Describe changes for ${targets.length === 1 ? targets[0]!.name : `all ${targets.length} target videos`}. Review each proposal before applying.` : 'Check videos in the source list to edit and export them.'}
      scope="Playback speed, horizontal flip, AI upscaling, captions, titles, animation, black bands, B-roll, uploaded footage, cuts, color, sound and output settings. Each target keeps its unrelated settings. Automatic selection or narration can propose a switch to Auto."
      applyLabel={`Apply to ${targets.length} video${targets.length === 1 ? '' : 's'}`}
      loadingMessage={`Preparing proposals: ${completed} of ${targets.length} videos…`}
      appliedMessage="Settings applied to the target videos. Preview or render when ready."
      undoBlockedMessage="Use workspace Undo to step back through newer edits and this prompt."
      applied={history.isApplied(appliedId)} canUndo={!!appliedId && history.undoId === appliedId} onUndo={() => {
        if (history.undoId === appliedId) { history.undo(); setAppliedId(undefined); }
      }} />
  </div>;
}
