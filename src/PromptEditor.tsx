import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, MessageSquareText, RotateCcw, X } from "lucide-react";
import type { PromptEditResponse } from "../shared/types";
import "./prompt-editor.css";

export type PromptProposal = PromptEditResponse;

const examples = [
  { label: "Smaller captions", prompt: "Make captions smaller and move them up." },
  { label: "Keep the first 20s", prompt: "Shorten this to the first 20 seconds." },
  { label: "Remove B-roll", prompt: "Remove the B-roll." },
];

/** Generates a reviewable proposal. Applying it never starts a render. */
export default function PromptEditor({ contextKey, disabled = false, onSuggest, onApply, onUndo, canUndo = false, applied = false }: {
  contextKey: string;
  disabled?: boolean;
  onSuggest: (prompt: string, signal: AbortSignal) => Promise<PromptProposal>;
  onApply: (proposal: PromptProposal) => void;
  onUndo: () => void;
  canUndo?: boolean;
  applied?: boolean;
}) {
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<{ value: PromptProposal; context: string; prompt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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

  return <section className="prompt-editor" aria-labelledby={`${id}-title`}>
    <div className="prompt-editor-heading">
      <span className="prompt-editor-icon" aria-hidden="true"><MessageSquareText size={19} /></span>
      <div><h3 id={`${id}-title`}>Edit with a prompt</h3><p>Describe a change. Review it before rendering.</p></div>
    </div>
    <label className="prompt-editor-label" htmlFor={`${id}-input`}>Describe your edit</label>
    <textarea ref={textarea} id={`${id}-input`} rows={3} maxLength={2000} value={prompt} disabled={disabled}
      placeholder="e.g. Make captions smaller and move them up"
      aria-describedby={`${id}-scope`} onChange={(event) => changePrompt(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void suggest(); }
      }} />
    <div className="prompt-editor-examples" aria-label="Example editing prompts">
      {examples.map((example) => <button key={example.label} type="button" disabled={disabled || loading}
        onClick={() => { changePrompt(example.prompt); textarea.current?.focus(); }}>{example.label}</button>)}
    </div>
    <div className="prompt-editor-actions">
      <span className="prompt-editor-provider">Text planning by DeepSeek</span>
      {loading ? <button type="button" className="secondary-button" onClick={() => {
        active.current?.abort(); active.current = null; setLoading(false); setNotice("Request cancelled. Your draft is unchanged.");
      }}><X size={14} />Cancel</button> : <button type="button" className="primary-button" disabled={disabled || !prompt.trim()}
        onClick={() => void suggest()}><ArrowUp size={15} />Suggest edits</button>}
    </div>
    <p id={`${id}-scope`} className="prompt-editor-scope">Hooks, captions, cut points, framing and B-roll. You can keep using the controls below.</p>
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
    {applied && !currentProposal && <div className="prompt-editor-applied" role="status"><p><Check size={15} />Prompt applied to your draft. Render this revision when ready.</p>
      <button type="button" className="secondary-button" disabled={disabled || !canUndo} onClick={onUndo}><RotateCcw size={14} />Undo last prompt</button>
      {!canUndo && <small>Your manual changes are newer. Reset changes to return to the saved export.</small>}
    </div>}
  </section>;
}
