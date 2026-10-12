import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Check, Pencil, X } from "lucide-react";
import { CaptionOverlay } from "./CaptionStyleEditor";
import { moveTextOverlay, textOverlayLayout, TEXT_LINE_HEIGHT, type TextOverlay, type TextOverlayPosition } from "../shared/text-overlays";
import "./text-overlays.css";

type TextChange = Partial<TextOverlayPosition> & { text?: string };
type Drag = { pointer: number; x: number; y: number; width: number; height: number; from: TextOverlayPosition; moved: boolean };

function CanvasText({ item, index, height, aspect, onCommit, onInteract }: {
  item: TextOverlay; index: number; height: number; aspect: number;
  onCommit?: (patch: TextChange) => void; onInteract?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), drag = useRef<Drag | null>(null);
  const editValue = useRef<string | null>(null);
  const [position, setPosition] = useState<TextOverlayPosition | null>(null);
  const [selected, setSelected] = useState(false), [editing, setEditing] = useState<string | null>(null);
  const shown = position ? { ...item, xPercent: position.xPercent, style: { ...item.style, bottomPercent: position.bottomPercent } } : item;
  const layout = textOverlayLayout(shown, height * aspect, height);
  const fontSize = layout.style.fontSize * height / 288;
  const placement: CSSProperties = { left: `${layout.left / (height * aspect) * 100}%`, width: `${layout.width / (height * aspect) * 100}%`, right: "auto",
    whiteSpace: "pre", overflowWrap: "normal", fontSize, fontFamily: layout.metrics.css, lineHeight: TEXT_LINE_HEIGHT };
  const isEditing = editing !== null;
  useEffect(() => { if (isEditing) { input.current?.focus(); input.current?.select(); } }, [isEditing]);
  useEffect(() => {
    if (!onCommit) { drag.current = null; editValue.current = null; setPosition(null); setEditing(null); setSelected(false); }
  }, [!!onCommit]);
  useEffect(() => {
    if (!selected) return;
    const outside = (event: globalThis.PointerEvent) => { if (!root.current?.contains(event.target as Node)) setSelected(false); };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [selected]);

  const finishEdit = (save: boolean) => {
    const text = editValue.current;
    if (text === null) return;
    editValue.current = null; setEditing(null);
    if (save && text !== item.text) onCommit?.({ text });
  };
  const beginEdit = () => {
    onInteract?.(); setSelected(true); editValue.current = item.text; setEditing(item.text);
  };
  const cancelDrag = () => {
    const current = drag.current; drag.current = null; setPosition(null);
    if (current && root.current?.hasPointerCapture(current.pointer)) root.current.releasePointerCapture(current.pointer);
  };
  const movedPosition = (event: PointerEvent<HTMLDivElement>, current: Drag) => {
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (Math.hypot(dx, dy) >= 3) current.moved = true;
    return moveTextOverlay(current.from, dx, dy, current.width, current.height);
  };
  const lettering = <CaptionOverlay style={{ ...shown.style, wordHighlight: false }} height={height} text={layout.text} displayed
    placement={{ ...placement, ...(onCommit ? { position: "relative", left: 0, bottom: 0, width: "100%" } : { zIndex: 4 }) }} />;
  if (!onCommit) return lettering;
  return <div ref={root} className={`canvas-text-object${selected ? " is-selected" : ""}${position ? " is-dragging" : ""}${isEditing ? " is-editing" : ""}`}
    style={{ ...placement, bottom: `${layout.style.bottomPercent}%`, zIndex: selected || isEditing ? 6 : 4 }}
    role="group" tabIndex={0} aria-label={`Text ${index + 1} on video`}
    aria-description="Drag to move. Double-click or press Enter to edit. Arrow keys move the text; Shift moves farther."
    onFocus={() => setSelected(true)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { finishEdit(true); setSelected(false); } }}
    onPointerDown={event => {
      if (isEditing || event.button !== 0 || !event.isPrimary) return;
      const canvas = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!canvas?.width || !canvas.height) return;
      event.preventDefault(); event.stopPropagation(); onInteract?.(); setSelected(true); event.currentTarget.focus({ preventScroll: true });
      drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: canvas.width, height: canvas.height,
        from: { xPercent: item.xPercent, bottomPercent: layout.style.bottomPercent }, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => { const current = drag.current; if (!current || current.pointer !== event.pointerId) return;
      const next = movedPosition(event, current); if (current.moved) setPosition(next);
    }}
    onPointerUp={event => {
      const current = drag.current; if (!current || current.pointer !== event.pointerId) return;
      const next = movedPosition(event, current); cancelDrag();
      if (current.moved && (next.xPercent !== current.from.xPercent || next.bottomPercent !== current.from.bottomPercent)) onCommit(next);
    }}
    onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
    onDoubleClick={event => { if (!isEditing) { event.preventDefault(); event.stopPropagation(); beginEdit(); } }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDrag(); setSelected(false); }
      else if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); event.stopPropagation(); beginEdit(); }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation(); onInteract?.();
        const step = event.shiftKey ? 5 : 1;
        onCommit(moveTextOverlay({ xPercent: item.xPercent, bottomPercent: layout.style.bottomPercent },
          event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
          event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0, 100, 100));
      }
    }}>
    {isEditing ? <textarea ref={input} className="canvas-text-input" aria-label={`Edit text ${index + 1} on video`} value={editing} maxLength={500}
      rows={Math.min(6, Math.max(layout.text.split("\n").length, editing.split("\n").length))} spellCheck
      style={{ fontSize, fontFamily: layout.metrics.css, fontWeight: layout.style.bold ? 700 : 400, fontStyle: layout.style.italic ? "italic" : "normal", textAlign: layout.style.alignment }}
      onChange={event => { const text = event.target.value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ""); editValue.current = text; setEditing(text); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); finishEdit(false); root.current?.focus(); }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); finishEdit(true); root.current?.focus(); }
      }} /> : lettering}
    {(selected || isEditing) && <div className={`canvas-text-tools${layout.style.bottomPercent < 20 ? " above" : ""}${shown.xPercent > 50 ? " align-right" : ""}`} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      {isEditing ? <>
        <button type="button" aria-label={`Save text ${index + 1}`} title="Save text (Ctrl/⌘ Enter)" onClick={() => { finishEdit(true); root.current?.focus(); }}><Check size={13} />Done</button>
        <button type="button" aria-label={`Cancel editing text ${index + 1}`} title="Cancel (Escape)" onClick={() => { finishEdit(false); root.current?.focus(); }}><X size={13} />Cancel</button>
      </> : <button type="button" aria-label={`Edit text ${index + 1} on video`} onClick={beginEdit}><Pencil size={13} />Edit text</button>}
    </div>}
  </div>;
}

export function TextOverlaysPreview({ items, time, height, aspect, onChange, onInteract, disabled = false }: {
  items?: TextOverlay[]; time: number; height: number; aspect: number;
  onChange?: (items: TextOverlay[]) => void; onInteract?: () => void; disabled?: boolean;
}) {
  if (!(height > 0 && aspect > 0)) return null;
  return <>{items?.map((item, index) => item.text.trim() && time >= item.start && time < item.end ? <CanvasText key={item.id} item={item} index={index} height={height} aspect={aspect}
    onInteract={onInteract} onCommit={!disabled && onChange ? patch => onChange(items.map(current => current.id === item.id ? { ...current,
      ...(patch.text === undefined ? {} : { text: patch.text }), ...(patch.xPercent === undefined ? {} : { xPercent: patch.xPercent }),
      ...(patch.bottomPercent === undefined ? {} : { style: { ...current.style, bottomPercent: patch.bottomPercent } }),
    } : current)) : undefined} /> : null)}</>;
}
