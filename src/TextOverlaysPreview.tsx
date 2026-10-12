import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Check, Pencil, X } from "lucide-react";
import { CaptionOverlay } from "./CaptionStyleEditor";
import { moveTextOverlay, resizeTextOverlay, textOverlayLayout, TEXT_LINE_HEIGHT, type TextOverlay, type TextOverlayPosition } from "../shared/text-overlays";
import "./text-overlays.css";

type TextChange = Partial<TextOverlayPosition> & { text?: string; fontSize?: number; widthPercent?: number };
type TextSize = { fontSize: number; widthPercent: number };
type Drag = { pointer: number; x: number; y: number; width: number; height: number; from: TextOverlayPosition; moved: boolean; resize?: TextSize };

function CanvasText({ item, index, height, aspect, time, selectOnMount, onCommit, onInteract }: {
  item: TextOverlay; index: number; height: number; aspect: number; time: number; selectOnMount: boolean;
  onCommit?: (patch: TextChange) => void; onInteract?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), drag = useRef<Drag | null>(null);
  const editValue = useRef<string | null>(null);
  const [position, setPosition] = useState<TextOverlayPosition | null>(null);
  const [size, setSize] = useState<TextSize | null>(null);
  const [selected, setSelected] = useState(selectOnMount && !!onCommit), [editing, setEditing] = useState<string | null>(null);
  const shown = { ...item, ...(position ? { xPercent: position.xPercent } : {}), ...(size ? { widthPercent: size.widthPercent } : {}),
    style: { ...item.style, ...(position ? { bottomPercent: position.bottomPercent } : {}), ...(size ? { fontSize: size.fontSize } : {}) } };
  const layout = textOverlayLayout(shown, height * aspect, height);
  const fontSize = layout.style.fontSize * height / 288;
  const placement: CSSProperties = { left: `${layout.left / (height * aspect) * 100}%`, width: `${layout.width / (height * aspect) * 100}%`, right: "auto",
    whiteSpace: "pre", overflowWrap: "normal", fontSize, fontFamily: layout.metrics.css, lineHeight: TEXT_LINE_HEIGHT };
  const isEditing = editing !== null;
  useEffect(() => { if (isEditing) { input.current?.focus(); input.current?.select(); } }, [isEditing]);
  useEffect(() => {
    if (!onCommit) { drag.current = null; editValue.current = null; setPosition(null); setSize(null); setEditing(null); setSelected(false); }
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
    const current = drag.current; drag.current = null; setPosition(null); setSize(null);
    if (current && root.current?.hasPointerCapture(current.pointer)) root.current.releasePointerCapture(current.pointer);
  };
  const movedPosition = (event: PointerEvent<HTMLDivElement>, current: Drag) => {
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (Math.hypot(dx, dy) >= 3) current.moved = true;
    return moveTextOverlay(current.from, dx, dy, current.width, current.height);
  };
  const lettering = <CaptionOverlay style={{ ...shown.style, wordHighlight: false, ...(selected && onCommit ? { animation: 'none' } : {}) }} height={height} text={layout.text} displayed blockBackground
    time={selected && onCommit ? (item.start + item.end) / 2 : time} start={item.start} end={item.end}
    placement={{ ...placement, ...(onCommit ? { position: "relative", left: 0, bottom: 0, width: "100%" } : { zIndex: 4 }) }} />;
  if (!onCommit) return lettering;
  return <div ref={root} className={`canvas-text-object${selected ? " is-selected" : ""}${position ? " is-dragging" : ""}${isEditing ? " is-editing" : ""}`}
    style={{ ...placement, bottom: `${layout.style.bottomPercent}%`, zIndex: selected || isEditing ? 6 : 4 }}
    role="group" tabIndex={0} aria-label={`Text ${index + 1} on video`}
    aria-description="Drag to move. Drag the corner handle to resize. Double-click or press Enter to edit. Arrow keys move the text; Shift moves farther."
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
      if (current.resize) { current.moved = true; setSize(resizeTextOverlay(current.resize, event.clientX - current.x, current.y - event.clientY, current.width, current.height)); return; }
      const next = movedPosition(event, current); if (current.moved) setPosition(next);
    }}
    onPointerUp={event => {
      const current = drag.current; if (!current || current.pointer !== event.pointerId) return;
      if (current.resize) { const next = resizeTextOverlay(current.resize, event.clientX - current.x, current.y - event.clientY, current.width, current.height); cancelDrag();
        if (next.fontSize !== current.resize.fontSize || next.widthPercent !== current.resize.widthPercent) onCommit(next); return; }
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
    {selected && !isEditing && <button type="button" className="canvas-text-resize" aria-label={`Resize text ${index + 1}`} title="Drag to resize; arrow keys adjust size"
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || !root.current) return;
        event.preventDefault(); event.stopPropagation(); onInteract?.();
        const box = root.current.getBoundingClientRect();
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: box.width, height: box.height,
          from: { xPercent: item.xPercent, bottomPercent: item.style.bottomPercent }, moved: false,
          resize: { fontSize: item.style.fontSize, widthPercent: item.widthPercent } };
        root.current.setPointerCapture(event.pointerId);
      }} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); onInteract?.();
        const delta = (event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 4 : 1);
        onCommit({ fontSize: Math.min(40, Math.max(12, item.style.fontSize + delta)) });
      }} />}
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
  const previous = useRef(items);
  const added = new Set(items?.filter(item => !previous.current?.some(saved => saved.id === item.id)).map(item => item.id));
  useEffect(() => { previous.current = items; }, [items]);
  if (!(height > 0 && aspect > 0)) return null;
  return <>{items?.map((item, index) => item.text.trim() && time >= item.start && time < item.end ? <CanvasText key={item.id} item={item} index={index} height={height} aspect={aspect} time={time} selectOnMount={added.has(item.id)}
    onInteract={onInteract} onCommit={!disabled && onChange ? patch => onChange(items.map(current => current.id === item.id ? { ...current,
      ...(patch.text === undefined ? {} : { text: patch.text }), ...(patch.xPercent === undefined ? {} : { xPercent: patch.xPercent }),
      ...(patch.widthPercent === undefined ? {} : { widthPercent: patch.widthPercent }),
      style: { ...current.style, ...(patch.bottomPercent === undefined ? {} : { bottomPercent: patch.bottomPercent }), ...(patch.fontSize === undefined ? {} : { fontSize: patch.fontSize }) },
    } : current)) : undefined} /> : null)}</>;
}
