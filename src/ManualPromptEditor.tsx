import { workspaceHistory, useWorkspaceHistory } from "./workspace-history";
import { apiRequest } from "./api-client";
import { useState } from "react";
import { DEFAULT_SETTINGS, type AutoOptions, type RemixSettings } from "../shared/types";
import PromptEditor, { type PromptExample, type ReviewablePrompt } from "./PromptEditor";

interface ManualPromptProposal extends ReviewablePrompt { settings: RemixSettings; auto?: { options: AutoOptions; variants: number } }

const examples: PromptExample[] = [
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

/** Key by source ID so prompts and undo always belong to the selected video. */
export default function ManualPromptEditor({ sourceId, settings, disabled = false, onApply, onSwitchAuto }: {
  sourceId: string;
  settings: RemixSettings;
  disabled?: boolean;
  onApply: (settings: RemixSettings) => void;
  onSwitchAuto: (value: { options: AutoOptions; variants: number }) => void;
}) {
  const history = useWorkspaceHistory();
  const [appliedId, setAppliedId] = useState<number>();
  const identity = JSON.stringify(settings);
  const suggest = async (prompt: string, signal: AbortSignal): Promise<ManualPromptProposal> => {
    return apiRequest<ManualPromptProposal>(`/api/sources/${sourceId}/edit-prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ prompt, settings }),
    });
  };
  const apply = (proposal: ManualPromptProposal) => {
    workspaceHistory.label("Apply prompt to video");
    if (proposal.auto) { onSwitchAuto(proposal.auto); setAppliedId(history.undoId); return; }
    const next = structuredClone({ ...DEFAULT_SETTINGS, ...proposal.settings });
    onApply(next); setAppliedId(history.undoId);
  };

  return <div className="manual-prompt-editor">
    <PromptEditor<ManualPromptProposal> contextKey={`${sourceId}:${identity}`} disabled={disabled} onSuggest={suggest} onApply={apply}
      examples={examples} placeholder="e.g. Add captions, black bands and 4 B-roll shots"
      description="Describe a change for the selected video."
      scope="AI upscaling, Captions, black bands, B-roll, animations, uploaded footage, cuts, color, sound and output settings. Automatic selection or narration can propose a switch to Auto. Apply changes to this video after reviewing."
      appliedMessage="Settings applied to this video. Preview or render when ready."
      undoBlockedMessage="Use workspace Undo to step back through newer edits and this prompt."
      applied={history.isApplied(appliedId)} canUndo={!!appliedId && history.undoId === appliedId} onUndo={() => {
        if (history.undoId === appliedId) { history.undo(); setAppliedId(undefined); }
      }} />
  </div>;
}
