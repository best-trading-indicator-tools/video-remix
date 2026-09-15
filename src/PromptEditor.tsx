import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, MessageSquareText, RotateCcw, X } from "lucide-react";
import type { EditPlan, PromptEditResponse } from "../shared/types";
import PromptHint from "./PromptHint";
import "./prompt-editor.css";

export type PromptProposal = PromptEditResponse;
export interface ReviewablePrompt { summary: string[]; clarification?: string }
export interface PromptExample { label: string; prompt: string }

export function savedEditExamples(plan: EditPlan): PromptExample[] {
  return [
    ...(plan.captions.length ? [
      { label: "Smaller captions", prompt: "Make the captions a little smaller." },
      { label: "Raise captions", prompt: "Move captions to 15% from the bottom." },
    ] : []),
    { label: "Fill the frame", prompt: "Fill the frame with a centered crop." },
    { label: "Keep whole picture", prompt: "Keep the whole picture with a blurred background." },
    ...(!plan.narration && plan.outputDuration > 20 ? [
      { label: "First 20 seconds", prompt: "Keep only the first 20 seconds of this edit." },
    ] : []),
    ...(plan.visuals.some(shot => shot.enabled && plan.media.some(media => media.id === shot.mediaId && media.kind === "broll")) ? [
      { label: "Remove B-roll", prompt: "Remove all video B-roll and show the original footage instead." },
    ] : []),
    { label: "Set opening title", prompt: "Change the opening title to 'Here's the key idea'." },
    ...(plan.settings.hookText ? [{ label: "Remove heading", prompt: "Remove the opening heading." }] : []),
    ...(plan.captions.length ? [{ label: "Remove captions", prompt: "Remove all captions." }] : []),
  ].slice(0, 8);
}

/** Generates a reviewable proposal. Applying it never starts a render. */
export default function PromptEditor<T extends ReviewablePrompt = PromptProposal>({ contextKey, disabled = false, onSuggest, onApply, onUndo, canUndo = false, applied = false,
  examples = [], scope = "Hooks, captions, cut points, framing and B-roll. You can keep using the controls below.",
  placeholder = "Describe what you’d like to change…", description = "Describe a change. Review it before rendering.",
  appliedMessage = "Prompt applied to your draft. Render this revision when ready.",
  undoBlockedMessage = "Your manual changes are newer. Reset changes to return to the saved export.",
}: {
  contextKey: string;
  disabled?: boolean;
  onSuggest: (prompt: string, signal: AbortSignal) => Promise<T>;
  onApply: (proposal: T) => void;
  onUndo: () => void;
  canUndo?: boolean;
  applied?: boolean;
  examples?: PromptExample[];
  scope?: string;
  placeholder?: string;
  description?: string;
  appliedMessage?: string;
  undoBlockedMessage?: string;
}) {
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<{ value: T; context: string; prompt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [engaged, setEngaged] = useState(false);
  const [expandedExamples, setExpandedExamples] = useState(false);
  const active = useRef<AbortController | null>(null);
  const currentContext = useRef(contextKey);
  const currentPrompt = useRef(prompt);
  const textarea = useRef<HTMLTextAreaElement>(null);
  currentContext.current = contextKey;
  currentPrompt.current = prompt;

  useEffect(() => {
    active.current?.abort();
    active.current = null;
    setLoading(false);
    setProposal(null);
    setError("");
    setNotice("");
  }, [contextKey]);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!disabled) return;
    active.current?.abort();
    active.current = null;
    setLoading(false);
    setProposal(null);
  }, [disabled]);

  const changePrompt = (value: string) => {
    active.current?.abort();
    active.current = null;
    currentPrompt.current = value;
    setPrompt(value);
    setLoading(false);
    setProposal(null);
    setError("");
    setNotice("");
  };

  const suggest = async () => {
    if (disabled || active.current || !prompt.trim()) return;
    const controller = new AbortController();
    const requestedContext = contextKey;
    const requestedPrompt = prompt;
    active.current = controller;
    setLoading(true);
    setProposal(null);
    setError("");
    setNotice("");
    try {
      const value = await onSuggest(prompt.trim(), controller.signal);
      if (!controller.signal.aborted && currentContext.current === requestedContext && currentPrompt.current === requestedPrompt) {
        setProposal({ value, context: requestedContext, prompt: requestedPrompt });
      }
    } catch (reason) {
      if (!controller.signal.aborted && currentContext.current === requestedContext) {
        setError(reason instanceof Error ? reason.message : "Your edit could not be suggested. Please try again.");
      }
    } finally {
      if (active.current === controller) { active.current = null; setLoading(false); }
    }
  };

  const currentProposal = proposal?.context === contextKey && proposal.prompt === prompt ? proposal.value : null;
  const canApply = !!currentProposal && !currentProposal.clarification && currentProposal.summary.length > 0;
  const showHint = !engaged && !prompt && !disabled && !loading;

  return <section className="prompt-editor" aria-labelledby={`${id}-title`}>
    <div className="prompt-editor-heading">
      <span className="prompt-editor-icon" aria-hidden="true"><MessageSquareText size={19} /></span>
      <div><h3 id={`${id}-title`}>Edit with a prompt</h3><p>{description}</p></div>
    </div>
    <label className="prompt-editor-label" htmlFor={`${id}-input`}>Describe your edit</label>
    <div className={`prompt-editor-input${showHint ? " has-hint" : ""}`}>
    <textarea ref={textarea} id={`${id}-input`} rows={3} maxLength={2000} value={prompt} disabled={disabled}
      placeholder={placeholder}
      onFocus={() => setEngaged(true)}
      aria-describedby={`${id}-scope`} onChange={(event) => changePrompt(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void suggest(); }
      }} />
    {showHint && <PromptHint examples={examples.map(example => example.prompt)} fallback={placeholder} />}
    </div>
    <div id={`${id}-examples`} className="prompt-editor-examples" role="group" aria-label="Example editing prompts">
      {(expandedExamples ? examples : examples.slice(0, 6)).map((example) => <button key={example.label} type="button" disabled={disabled || loading}
        title={example.prompt}
        onClick={() => { changePrompt(example.prompt); textarea.current?.focus(); }}>{example.label}</button>)}
    </div>
    {examples.length > 6 && <button type="button" className="prompt-editor-more" aria-expanded={expandedExamples} aria-controls={`${id}-examples`}
      onClick={() => setExpandedExamples(value => !value)}>{expandedExamples ? "Fewer ideas" : "More ideas"}<span aria-hidden="true">{expandedExamples ? "−" : "+"}</span></button>}
    <div className="prompt-editor-actions">
      <span className="prompt-editor-provider">Text planning by DeepSeek</span>
      {loading ? <button type="button" className="secondary-button" onClick={() => {
        active.current?.abort(); active.current = null; setLoading(false); setNotice("Request cancelled. Your draft is unchanged.");
      }}><X size={14} />Cancel</button> : <button type="button" className="primary-button" disabled={disabled || !prompt.trim()}
        onClick={() => void suggest()}><ArrowUp size={15} />Suggest edits</button>}
    </div>
    <p id={`${id}-scope`} className="prompt-editor-scope">{scope}</p>
    {loading && <p className="prompt-editor-status" role="status"><LoaderCircle className="spin" size={15} />Working out your changes…</p>}
    {error && <p className="prompt-editor-error" role="alert">{error}</p>}
    {notice && <p className="prompt-editor-status" role="status">{notice}</p>}
    {currentProposal && <div className={`prompt-editor-proposal ${currentProposal.clarification ? "needs-detail" : ""}`} aria-live="polite">
      <div className="prompt-editor-proposal-heading"><strong>{currentProposal.clarification ? "A little more detail" : "Proposed changes"}</strong>
        {!currentProposal.clarification && <span>Ready to review</span>}</div>
      {currentProposal.clarification ? <p>{currentProposal.clarification}</p> : <ul>{currentProposal.summary.map((item, index) => <li key={`${index}-${item}`}><Check size={14} aria-hidden="true" /><span>{item}</span></li>)}</ul>}
      <div className="prompt-editor-review-actions">
        {canApply && <button type="button" className="primary-button" disabled={disabled} onClick={() => {
          if (currentProposal && currentContext.current === proposal?.context && currentPrompt.current === proposal?.prompt) {
            onApply(currentProposal); setProposal(null); setNotice("");
          }
        }}><Check size={15} />Apply to draft</button>}
        <button type="button" className="secondary-button" disabled={disabled} onClick={() => { setProposal(null); textarea.current?.focus(); }}>Discard</button>
      </div>
    </div>}
    {applied && !currentProposal && <div className="prompt-editor-applied" role="status"><p><Check size={15} />{appliedMessage}</p>
      <button type="button" className="secondary-button" disabled={disabled || !canUndo} onClick={onUndo}><RotateCcw size={14} />Undo last prompt</button>
      {!canUndo && <small>{undoBlockedMessage}</small>}
    </div>}
  </section>;
}
