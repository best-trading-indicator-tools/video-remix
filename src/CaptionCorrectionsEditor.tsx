import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { captionCorrectionSchema, correctCaptionCues, type CaptionCorrection } from '../shared/caption-corrections';
import type { CaptionCue } from '../shared/types';
import './caption-style.css';

function CorrectionForm({ onApply, captions, full = false }: { onApply: (rule: CaptionCorrection) => void; captions?: CaptionCue[]; full?: boolean }) {
  const [find, setFind] = useState(''), [replace, setReplace] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false), [wholeWord, setWholeWord] = useState(true);
  const rule = captionCorrectionSchema.safeParse({ find, replace, caseSensitive, wholeWord });
  let preview: ReturnType<typeof correctCaptionCues<CaptionCue>> | undefined, error = '';
  if (captions && rule.success) { try { preview = correctCaptionCues(captions, [rule.data]); } catch (failure) { error = (failure as Error).message; } }
  return <div className="caption-correction-form">
    <label>Find<input aria-label="Find caption text" maxLength={100} value={find} placeholder="Misspelled name or phrase" onChange={event => setFind(event.target.value)} /></label>
    <label>Replace with<input aria-label="Replacement caption text" maxLength={100} value={replace} placeholder="Correct spelling (blank removes it)" onChange={event => setReplace(event.target.value)} /></label>
    <div className="caption-correction-flags">
      <label><input type="checkbox" checked={wholeWord} onChange={event => setWholeWord(event.target.checked)} />Whole words</label>
      <label><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} />Match case</label>
    </div>
    {find && !rule.success && <p role="alert">Use plain text without subtitle markup or line breaks.</p>}
    {error && <p role="alert">{error}</p>}
    {preview && <p role="status">{preview.matches} match{preview.matches === 1 ? '' : 'es'} in {preview.changed} caption{preview.changed === 1 ? '' : 's'}.</p>}
    {preview && preview.changed > 0 && <div className="caption-correction-example">{preview.captions.find(cue => captions?.find(original => original.id === cue.id)?.text !== cue.text)?.text || 'Matching captions will be removed.'}</div>}
    <button type="button" className="secondary-button" disabled={!rule.success || !!error || full || (!!captions && !preview?.changed)} onClick={() => {
      if (rule.success) { onApply(rule.data); setFind(''); setReplace(''); }
    }}><Plus size={13} />{captions ? 'Replace all matches' : 'Add correction rule'}</button>
  </div>;
}

export default function CaptionCorrectionsEditor({ value = [], onChange, scopeDescription, disabled = false }: {
  value?: CaptionCorrection[]; onChange: (rules: CaptionCorrection[]) => void; scopeDescription?: string; disabled?: boolean;
}) {
  return <details className="caption-corrections"><summary>Bulk caption corrections{value.length ? ` · ${value.length} rule${value.length === 1 ? '' : 's'}` : ''}</summary>
    <p className="caption-style-note">{scopeDescription ? `${scopeDescription}. ` : ''}Fix names and repeated mistakes in every added caption at export. Rules run in order. Text already baked into the picture cannot be corrected.</p>
    <fieldset disabled={disabled}>
      {value.map((rule, index) => <div className="caption-correction-rule" key={index}><span><strong>{rule.find}</strong> → {rule.replace || '(remove)'}<small>{rule.wholeWord ? 'Whole words' : 'Any match'} · {rule.caseSensitive ? 'Match case' : 'Ignore case'}</small></span>
        <button type="button" className="secondary-button" aria-label={`Remove correction ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={13} /></button></div>)}
      <CorrectionForm full={value.length >= 50} onApply={rule => onChange([...value, rule])} />
    </fieldset>
  </details>;
}

export function BulkCaptionCorrection({ captions, onChange }: { captions: CaptionCue[]; onChange: (captions: CaptionCue[]) => void }) {
  return <details className="caption-corrections"><summary>Find and replace in all captions</summary>
    <p className="caption-style-note">Preview matches, then replace them together. Timings stay unchanged. Undo restores the previous wording.</p>
    <CorrectionForm captions={captions} onApply={rule => onChange(correctCaptionCues(captions, [rule]).captions)} />
  </details>;
}
