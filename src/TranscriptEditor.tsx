import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { FileText, LoaderCircle, Play, Plus, Scissors, Search, Undo2, X } from "lucide-react";
import type { Transcript, VideoSource } from "../shared/types";
import { formatSourceClock, MAX_SHORT_CUTS, type ShortCut, type ShortDraft } from "../shared/shorts";
import { addTranscriptSelection, cutCoverage, findTranscriptWords, removeTranscriptSelection, selectionInterval, selectionTitle,
  transcriptWords, type TranscriptEvent, type TranscriptWordRef } from "../shared/transcript-edit";
import "./transcript.css";

type Progress = { message: string; progress: number };
/**
 * Transcripts fetched in this tab, and preparations that keep running while another video is selected.
 * The server keeps the durable copy, so a reload only needs a fast lookup.
 */
const loaded = new Map<string, Transcript>();
const preparing = new Map<string, { controller: AbortController; progress: Progress; error?: string }>();
const checking = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(listener => listener());

async function checkSaved(sourceId: string) {
  if (loaded.has(sourceId) || preparing.has(sourceId) || checking.has(sourceId)) return;
  checking.add(sourceId); changed();
  try {
    const response = await fetch(`/api/shorts/transcript/${encodeURIComponent(sourceId)}`);
    const data = await response.json();
    if (response.ok && data.transcript) loaded.set(sourceId, data.transcript as Transcript);
  } catch { /* Transcribing reports any problem explicitly. */ }
  checking.delete(sourceId); changed();
}

async function prepare(sourceId: string) {
  if (preparing.has(sourceId) && !preparing.get(sourceId)!.error) return;
  const job = { controller: new AbortController(), progress: { message: "Preparing the local transcript…", progress: 0 } as Progress, error: undefined as string | undefined };
  preparing.set(sourceId, job); changed();
  const { signal } = job.controller;
  try {
    const request = () => fetch("/api/shorts/transcript", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId }), signal });
    let response = await request();
    // A cancelled preparation can take a moment to release this video on the server.
    for (let attempt = 1; response.status === 409 && attempt <= 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1200)); signal.throwIfAborted();
      response = await request();
    }
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The transcript could not be prepared.");
    const reader = response.body?.getReader(); if (!reader) throw new Error("Streaming is unavailable. Please retry.");
    const decoder = new TextDecoder(), received: { transcript?: Transcript } = {};
    let pending = "";
    const receive = (line: string) => {
      if (!line.trim()) return;
      let event: TranscriptEvent;
      try { event = JSON.parse(line) as TranscriptEvent; } catch { throw new Error("The transcript response was incomplete. Retry to continue."); }
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "progress") { job.progress = { message: event.message, progress: event.progress }; changed(); }
      if (event.type === "result") received.transcript = event.transcript;
    };
    while (true) {
      const part = await reader.read(); pending += decoder.decode(part.value, { stream: !part.done });
      const lines = pending.split("\n"); pending = lines.pop() || ""; lines.forEach(receive);
      if (part.done) { receive(pending); break; }
    }
    if (!received.transcript) throw new Error("Transcription was interrupted. Retry to continue.");
    loaded.set(sourceId, received.transcript); preparing.delete(sourceId);
  } catch (error) {
    if (signal.aborted) preparing.delete(sourceId);
    else job.error = error instanceof Error ? error.message : "The transcript could not be prepared.";
  }
  changed();
}

const wordIndex = (element: Element | null): number | null => {
  const value = element?.closest<HTMLElement>("[data-w]")?.dataset.w;
  return value === undefined ? null : Number(value);
};
const edgeWord = (node: Node, edge: "first" | "last"): number | null => {
  if (node.nodeType === Node.TEXT_NODE) return wordIndex(node.parentElement);
  if (!(node instanceof Element)) return null;
  if (node.matches("[data-w]")) return wordIndex(node);
  const matches = node.querySelectorAll<HTMLElement>("[data-w]");
  const match = edge === "first" ? matches[0] : matches[matches.length - 1];
  return match ? Number(match.dataset.w) : null;
};
/** The first (start) or last (end) word a DOM range boundary selects. Touching only a word's edge does not select it. */
function boundaryWord(node: Node, offset: number, edge: "start" | "end"): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const index = wordIndex(node.parentElement);
    if (index === null) return null;
    const text = node.textContent || "";
    if (edge === "start") return text.slice(offset).trim() ? index : index + 1;
    return text.slice(0, offset).trim() ? index : index - 1;
  }
  if (!(node instanceof Element)) return null;
  const children = node.childNodes;
  if (node.matches("[data-w]")) {
    const index = wordIndex(node)!;
    return edge === "start" ? offset < children.length ? index : index + 1 : offset > 0 ? index : index - 1;
  }
  if (edge === "start") {
    for (let i = offset; i < children.length; i++) { const found = edgeWord(children[i]!, "first"); if (found !== null) return found; }
    const inside = edgeWord(node, "last");
    return inside === null ? null : inside + 1;
  }
  for (let i = offset - 1; i >= 0; i--) { const found = edgeWord(children[i]!, "last"); if (found !== null) return found; }
  const inside = edgeWord(node, "first");
  return inside === null ? null : inside - 1;
}

const clockLabel = (seconds: number) => formatSourceClock(seconds).replace(/^00:/, "").replace(/\.\d{3}$/, "");
const cutsKey = (cuts: ShortCut[]) => JSON.stringify(cuts.map(({ id, start, end }) => [id, start, end]));
const UNCERTAIN = 0.45;

/** One recognized passage. Props are primitives so playback only re-renders the passages that changed. */
const TranscriptSegment = memo(function TranscriptSegment({ words, sequence, markers, editing, selFirst, selLast, playing, cursor }: {
  words: TranscriptWordRef[]; sequence: string; markers: string; editing: boolean; selFirst: number; selLast: number; playing: number; cursor: number;
}) {
  const included = sequence ? sequence.split(",") : [];
  const starts = new Map(markers ? markers.split(";").map(item => item.split(":").map(Number) as [number, number]) : []);
  return <p className="transcript-segment" data-time={clockLabel(words[0]!.start)}>
    {words.map((word, offset) => {
      const uncertain = (word.probability ?? 1) < UNCERTAIN;
      const className = ["transcript-word", editing ? Number(included[offset]) > 0 ? "included" : "excluded" : "",
        word.index >= selFirst && word.index <= selLast ? "selected" : "", word.index === playing ? "playing" : "",
        word.index === cursor ? "cursor" : "", uncertain ? "uncertain" : ""].filter(Boolean).join(" ");
      return <span key={word.index} data-w={word.index} data-seq={starts.get(word.index)} className={className} title={uncertain ? "Low recognition confidence" : undefined}>{word.text}</span>;
    })}
  </p>;
});

type Props = {
  source?: VideoSource;
  /** The active short; editing applies only when it uses this source. */
  draft?: ShortDraft;
  active: boolean;
  disabled: boolean;
  engineReady: boolean;
  playhead: number;
  canCreate: boolean;
  onSeek: (seconds: number) => void;
  onPlayRange: (start: number, end: number) => void;
  onCutsChange: (cuts: ShortCut[]) => void;
  onCreate: (start: number, end: number, title: string) => void;
};

export default function TranscriptEditor({ source, draft, active, disabled, engineReady, playhead, canCreate, onSeek, onPlayRange, onCutsChange, onCreate }: Props) {
  const [, refresh] = useState(0);
  const [chosenRange, setSelection] = useState<{ first: number; last: number } | null>(null);
  const [chosenAnchor, setAnchor] = useState<number | null>(null);
  const [chosenCursor, setCursor] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<{ draftId: string; before: ShortCut[]; after: string }[]>([]);
  const container = useRef<HTMLDivElement>(null);
  const pointerDown = useRef(false);
  const sourceId = source?.id, hasAudio = source?.hasAudio !== false;
  const transcript = sourceId ? loaded.get(sourceId) : undefined;
  const job = sourceId ? preparing.get(sourceId) : undefined;
  const words = useMemo(() => transcript ? transcriptWords(transcript) : [], [transcript]);
  const segments = useMemo(() => {
    const groups: TranscriptWordRef[][] = [];
    for (const word of words) { const last = groups.at(-1); if (last && last[0]!.segment === word.segment) last.push(word); else groups.push([word]); }
    return groups;
  }, [words]);
  // A selection only counts for the words on screen; a reloaded or replaced transcript can be shorter.
  const selection = chosenRange && chosenRange.last < words.length ? chosenRange : null;
  const anchor = chosenAnchor !== null && chosenAnchor < words.length ? chosenAnchor : null;
  const cursor = chosenCursor !== null && chosenCursor < words.length ? chosenCursor : null;
  const editing = !!draft && !!source && draft.sourceId === source.id;
  const coverage = useMemo(() => editing ? cutCoverage(words, draft!.cuts) : null, [editing, words, draft?.cuts]);
  const playing = useMemo(() => {
    let low = 0, high = words.length - 1, found = -1;
    while (low <= high) { const middle = (low + high) >> 1; if (words[middle]!.start <= playhead) { found = middle; low = middle + 1; } else high = middle - 1; }
    return found >= 0 && playhead <= words[found]!.end + 0.05 ? found : -1;
  }, [words, playhead]);

  useEffect(() => {
    const listener = () => refresh(value => value + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  useEffect(() => { if (active && sourceId && hasAudio) void checkSaved(sourceId); }, [active, sourceId, hasAudio]);
  useEffect(() => {
    const released = () => { pointerDown.current = false; };
    document.addEventListener("pointerup", released); document.addEventListener("pointercancel", released);
    return () => { document.removeEventListener("pointerup", released); document.removeEventListener("pointercancel", released); };
  }, []);
  // Mouse drags, double-clicks and touch selection handles all arrive as native selections.
  useEffect(() => {
    const update = () => {
      const element = container.current, native = document.getSelection();
      if (!element || !native || native.isCollapsed || !native.rangeCount) return;
      const range = native.getRangeAt(0);
      if (!element.contains(range.commonAncestorContainer)) return;
      const first = boundaryWord(range.startContainer, range.startOffset, "start"), last = boundaryWord(range.endContainer, range.endOffset, "end");
      if (first === null || last === null) return;
      const from = Math.max(0, first), to = Math.min(words.length - 1, last);
      if (from > to) return;
      setSelection({ first: from, last: to }); setAnchor(from); setCursor(to);
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [words.length]);
  // Word elements always exist once the transcript renders, so scrolling needs no animation frame.
  const reveal = (index: number) => {
    const element = container.current, word = element?.querySelector<HTMLElement>(`[data-w="${index}"]`);
    if (!element || !word) return;
    const box = element.getBoundingClientRect(), item = word.getBoundingClientRect();
    if (item.top < box.top + 6 || item.bottom > box.bottom - 6) element.scrollTop += item.top - box.top - box.height / 3;
  };
  useEffect(() => { if (active && follow && playing >= 0 && !pointerDown.current) reveal(playing); }, [active, follow, playing]);

  if (!source) return null;
  const choose = (from: number, to: number, keep = from) => { setSelection({ first: Math.min(from, to), last: Math.max(from, to) }); setAnchor(keep); setCursor(to); setNotice(""); };
  const clear = () => { setSelection(null); document.getSelection()?.removeAllRanges(); };
  const interval = selection ? selectionInterval(words, selection.first, selection.last, source.duration) : null;
  const count = selection ? selection.last - selection.first + 1 : 0;
  const selectedIncluded = !!selection && !!coverage && coverage.sequence.slice(selection.first, selection.last + 1).some(Boolean);
  const canAdd = editing && !!interval && !disabled && draft!.cuts.length < MAX_SHORT_CUTS;
  const canRemove = editing && selectedIncluded && !disabled;
  const lastEdit = history.at(-1);
  const canUndo = editing && !disabled && !!lastEdit && lastEdit.draftId === draft!.id && lastEdit.after === cutsKey(draft!.cuts);
  const commit = (cuts: ShortCut[], message: string) => {
    setHistory(stack => [...stack.slice(-19), { draftId: draft!.id, before: draft!.cuts, after: cutsKey(cuts) }]);
    onCutsChange(cuts); clear(); setNotice(message);
  };
  const add = () => {
    if (!canAdd) return;
    const result = addTranscriptSelection(draft!.cuts, interval!, crypto.randomUUID());
    if (typeof result === "string") setNotice(result);
    else commit(result, `Added ${count} word${count === 1 ? "" : "s"} as sequence ${result.length}.`);
  };
  const remove = () => {
    if (!canRemove) return;
    const result = removeTranscriptSelection(draft!.cuts, words, selection!.first, selection!.last, () => crypto.randomUUID());
    if (typeof result === "string") setNotice(result);
    else commit(result, `Removed ${count} word${count === 1 ? "" : "s"} from this short.`);
  };
  const undo = () => {
    if (!canUndo) return;
    onCutsChange(lastEdit!.before); setHistory(stack => stack.slice(0, -1)); setNotice("Last transcript edit undone.");
  };
  const create = () => {
    if (!interval || !selection || !canCreate || disabled) return;
    onCreate(interval.start, interval.end, selectionTitle(words, selection.first, selection.last));
    clear(); setNotice("New short created from your selection.");
  };
  const find = () => {
    const found = findTranscriptWords(words, query, selection?.first ?? playing);
    if (!found) { setNotice(query.trim() ? `No match for “${query.trim()}”.` : ""); return; }
    document.getSelection()?.removeAllRanges(); choose(found.first, found.last); onSeek(words[found.first]!.start); reveal(found.first);
  };
  const click = (event: MouseEvent<HTMLDivElement>) => {
    const index = wordIndex(event.target as Element);
    if (event.shiftKey && anchor !== null && index !== null && words[index]) {
      // Include the clicked word even when the browser put its caret before a short word's letters.
      // Clearing the native range also makes the pending selection change a no-op.
      document.getSelection()?.removeAllRanges(); choose(anchor, index, anchor); return;
    }
    const native = document.getSelection();
    if (native && !native.isCollapsed) return;
    if (index === null || !words[index]) return;
    choose(index, index); onSeek(words[index]!.start);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!words.length) return;
    const current = cursor ?? selection?.last ?? Math.max(0, playing);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = Math.min(words.length - 1, current + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = words.length - 1;
    else if (event.key === "Enter") { event.preventDefault(); onSeek(words[selection?.first ?? current]!.start); return; }
    else if (event.key === "Escape" && selection) { event.preventDefault(); clear(); return; }
    else if ((event.key === "Delete" || event.key === "Backspace") && canRemove) { event.preventDefault(); remove(); return; }
    if (next === null) return;
    event.preventDefault(); document.getSelection()?.removeAllRanges();
    if (event.shiftKey) choose(anchor ?? current, next, anchor ?? current); else choose(next, next);
    reveal(next);
  };

  const status = transcript ? "ready" : job ? job.error ? "error" : "loading" : checking.has(source.id) ? "checking" : "missing";
  return <section className="shorts-transcript" aria-labelledby="shorts-transcript-title">
    <div className="transcript-heading"><h3 id="shorts-transcript-title"><FileText size={15} />Edit with the transcript</h3><span>Free · local</span></div>
    {!hasAudio ? <p className="shorts-helper">This video has no audio track, so there is no transcript. Set sequences with timestamps instead.</p>
      : status === "checking" ? <p className="transcript-status" role="status"><LoaderCircle size={14} className="spin" />Looking for a saved transcript…</p>
      : status === "missing" ? <div className="transcript-start">
        <p className="shorts-helper">Read the speech, then build the short by selecting words instead of typing timestamps. Your local speech model transcribes it; long recordings take a while and are saved for next time.</p>
        <button className="secondary-button" disabled={!engineReady} onClick={() => void prepare(source.id)}><FileText size={14} />Transcribe this video</button>
      </div>
      : status === "loading" ? <div className="transcript-status" role="status">
        <LoaderCircle size={15} className="spin" /><span>{job!.progress.message}</span>
        <progress value={job!.progress.progress} max={100} aria-label="Transcription progress" />
        <button className="text-button" onClick={() => job!.controller.abort()}><X size={13} />Cancel</button>
      </div>
      : status === "error" ? <div className="transcript-start">
        <p className="shorts-error" role="alert">{job!.error}</p>
        <button className="secondary-button" disabled={!engineReady} onClick={() => void prepare(source.id)}>Retry transcript</button>
      </div>
      : !words.length ? <p className="shorts-helper">No words were recognized in this video. Set sequences with timestamps instead.</p>
      : <>
        <div className="transcript-tools">
          <form className="transcript-find" role="search" onSubmit={event => { event.preventDefault(); find(); }}>
            <label className="visually-hidden" htmlFor="transcript-query">Find words in the transcript</label>
            <input id="transcript-query" type="search" value={query} placeholder="Find words" maxLength={200} onChange={event => setQuery(event.target.value)} />
            <button className="secondary-button" type="submit" disabled={!query.trim()} aria-label="Find next match"><Search size={14} /></button>
          </form>
          <label className="transcript-follow"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /><span>Follow playback</span></label>
        </div>
        <p className="shorts-helper" id="shorts-transcript-help">{editing
          ? "Click a word to jump there. Drag across words or Shift-click to select. Bright words are in this short; numbers mark where each sequence starts. Keys: arrows move, Shift+arrows select, Delete removes."
          : "Click a word to jump there. Drag across words or Shift-click to select, then make a new short. Select a short from this video to add or remove words."}</p>
        <div ref={container} className="transcript-words" tabIndex={0} role="group" aria-label={`Transcript of ${source.name}`} aria-describedby="shorts-transcript-help"
          onClick={click} onKeyDown={key} onPointerDown={() => { pointerDown.current = true; }}
          onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}>
          {segments.map(group => {
            const first = group[0]!.index, last = group.at(-1)!.index;
            const within = (value: number | null) => value !== null && value >= first && value <= last ? value : -1;
            const selFirst = selection && selection.last >= first && selection.first <= last ? Math.max(selection.first, first) : -1;
            return <TranscriptSegment key={first} words={group} editing={!!coverage}
              sequence={coverage ? group.map(word => coverage.sequence[word.index]).join(",") : ""}
              markers={coverage ? group.flatMap(word => coverage.starts.has(word.index) ? [`${word.index}:${coverage.starts.get(word.index)}`] : []).join(";") : ""}
              selFirst={selFirst} selLast={selFirst >= 0 ? Math.min(selection!.last, last) : -1} playing={within(playing)} cursor={within(cursor)} />;
          })}
        </div>
        <div className="transcript-selection" aria-live="polite">
          {selection && interval ? <p><strong>{count} word{count === 1 ? "" : "s"} selected</strong><span>{formatSourceClock(interval.start)} → {formatSourceClock(interval.end)} · {(interval.end - interval.start).toFixed(1)}s</span></p>
            : <p className="shorts-helper">{notice || "Select words to play them, add them to a short, or remove them."}</p>}
          {selection && notice && <p className="shorts-helper">{notice}</p>}
        </div>
        <div className="transcript-actions">
          <button className="secondary-button" disabled={!interval} onClick={() => interval && onPlayRange(interval.start, interval.end)}><Play size={14} />Play selection</button>
          {editing && <button className="secondary-button" disabled={!canAdd} onClick={add}><Plus size={14} />Add as sequence {draft!.cuts.length + 1}</button>}
          {editing && <button className="secondary-button" disabled={!canRemove} onClick={remove}><Scissors size={14} />Remove from short</button>}
          <button className="secondary-button" disabled={!interval || !canCreate || disabled} onClick={create}><Plus size={14} />New short from selection</button>
          {canUndo && <button className="text-button" onClick={undo}><Undo2 size={14} />Undo transcript edit</button>}
          {selection && <button className="text-button" onClick={clear}><X size={13} />Clear selection</button>}
        </div>
      </>}
  </section>;
}
