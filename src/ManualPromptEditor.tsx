import { apiRequest } from "./api-client";
import { useState } from "react";
import { DEFAULT_SETTINGS, type AutoOptions, type RemixSettings } from "../shared/types";
import PromptEditor, { type PromptExample, type ReviewablePrompt } from "./PromptEditor";

interface ManualPromptProposal extends ReviewablePrompt { settings: RemixSettings; auto?: { options: AutoOptions; variants: number } }
interface SettingsUndo { settings: RemixSettings; appliedIdentity: string }
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
  const [undo, setUndo] = useState<SettingsUndo | null>(null);
  const identity = JSON.stringify(settings);
  const suggest = async (prompt: string, signal: AbortSignal): Promise<ManualPromptProposal> => {
    return apiRequest<ManualPromptProposal>(`/api/sources/${sourceId}/edit-prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ prompt, settings }),
    });
  };
  const apply = (proposal: ManualPromptProposal) => {
    if (proposal.auto) { onSwitchAuto(proposal.auto); return; }
    const next = structuredClone({ ...DEFAULT_SETTINGS, ...proposal.settings });
    setUndo({ settings: structuredClone(settings), appliedIdentity: JSON.stringify(next) });
    onApply(next);
  };

  return <div className="manual-prompt-editor">
    <PromptEditor<ManualPromptProposal> contextKey={`${sourceId}:${identity}`} disabled={disabled} onSuggest={suggest} onApply={apply}
      examples={examples} placeholder="e.g. Add captions, black bands and 4 B-roll shots"
      description="Describe a change for the selected video."
      scope="AI upscaling, Captions, black bands, B-roll, animations, uploaded footage, cuts, color, sound and output settings. Automatic selection or narration can propose a switch to Auto. Apply changes to this video after reviewing."
      appliedMessage="Settings applied to this video. Preview or render when ready."
      undoBlockedMessage="Your newer manual changes are kept. Undo is available while the last prompt is still the latest edit."
      applied={!!undo} canUndo={!!undo && undo.appliedIdentity === identity} onUndo={() => {
        if (!undo || undo.appliedIdentity !== identity) return;
        onApply(structuredClone(undo.settings)); setUndo(null);
      }} />
  </div>;
}
