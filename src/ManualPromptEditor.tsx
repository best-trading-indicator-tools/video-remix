import { apiRequest } from "./api-client";
import { useState } from "react";
import { DEFAULT_SETTINGS, type RemixSettings } from "../shared/types";
import PromptEditor, { type PromptExample, type ReviewablePrompt } from "./PromptEditor";

interface ManualPromptProposal extends ReviewablePrompt { settings: RemixSettings }
interface SettingsUndo { settings: RemixSettings; appliedIdentity: string }
const examples: PromptExample[] = [
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
export default function ManualPromptEditor({ sourceId, settings, disabled = false, onApply }: {
  sourceId: string;
  settings: RemixSettings;
  disabled?: boolean;
  onApply: (settings: RemixSettings) => void;
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
    const next = structuredClone({ ...DEFAULT_SETTINGS, ...proposal.settings, audioId: settings.audioId, subtitleId: settings.subtitleId });
    setUndo({ settings: structuredClone(settings), appliedIdentity: JSON.stringify(next) });
    onApply(next);
  };

  return <div className="manual-prompt-editor">
    <PromptEditor<ManualPromptProposal> contextKey={`${sourceId}:${identity}`} disabled={disabled} onSuggest={suggest} onApply={apply}
      examples={examples} placeholder="e.g. A little warmer, with more contrast"
      description="Describe a change for the selected video."
      scope="Color, speed, audio, framing, trim and titles. Review the changes, then apply them to this video."
      appliedMessage="Settings applied to this video. Preview or render when ready."
      undoBlockedMessage="Your newer manual changes are kept. Undo is available while the last prompt is still the latest edit."
      applied={!!undo} canUndo={!!undo && undo.appliedIdentity === identity} onUndo={() => {
        if (!undo || undo.appliedIdentity !== identity) return;
        onApply(structuredClone(undo.settings)); setUndo(null);
      }} />
  </div>;
}
