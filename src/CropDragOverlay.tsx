import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { Move } from "lucide-react";
import type { FocalPoint } from "../shared/types";
import { containedMediaRectangle, dragCropPoint, visibleCropCenter, type CropGuide, type MediaRectangle } from "../shared/crop-drag";

const CONTROL_CLEARANCE = 64;
interface PictureGeometry extends MediaRectangle { controlTop: number }
interface Drag {
  pointerId: number;
  clientX: number;
  clientY: number;
  start: FocalPoint;
  current: FocalPoint;
  crop: CropGuide;
  picture: PictureGeometry;
  target: HTMLButtonElement;
}

export default function CropDragOverlay({ videoRef, source, crop, label, disabled, onChange, onDragStateChange }: {
  videoRef: RefObject<HTMLVideoElement | null>;
  source: { width: number; height: number };
  crop: CropGuide;
  label: string;
  disabled: boolean;
  onChange: (point: FocalPoint) => void;
  onDragStateChange?: (dragging: boolean) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const geometry = useRef<PictureGeometry | null>(null);
  const [picture, setPicture] = useState<PictureGeometry | null>(null);
  const [pending, setPending] = useState<FocalPoint | null>(null);
  const dragStateChange = useRef(onDragStateChange);
  dragStateChange.current = onDragStateChange;
  const instructionsId = useId();
  const release = (current: Drag | null) => {
    if (current?.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  };
  const cancel = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    setPending(null);
    release(current);
    if (current) dragStateChange.current?.(false);
  }, []);

  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video || !layer.current) return;
    const measure = () => {
      const box = video.getBoundingClientRect(), overlay = layer.current!.getBoundingClientRect();
      const contained = containedMediaRectangle(box.width, box.height, video.videoWidth || source.width, video.videoHeight || source.height);
      const next = contained ? {
        ...contained, left: box.left - overlay.left + contained.left, top: box.top - overlay.top + contained.top,
        controlTop: box.bottom - overlay.top - CONTROL_CLEARANCE,
      } : null;
      if (JSON.stringify(geometry.current) !== JSON.stringify(next)) {
        geometry.current = next; setPicture(next); cancel();
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(video); observer.observe(layer.current);
    video.addEventListener("loadedmetadata", measure);
    return () => { observer.disconnect(); video.removeEventListener("loadedmetadata", measure); };
  }, [videoRef, source.width, source.height, cancel]);

  useEffect(() => { cancel(); }, [disabled, crop.left, crop.top, crop.width, crop.height, cancel]);
  useEffect(() => () => { const current = drag.current; drag.current = null; release(current); if (current) dragStateChange.current?.(false); }, []);

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();
    current.current = dragCropPoint(current.crop, current.start, event.clientX - current.clientX, event.clientY - current.clientY, current.picture);
    setPending(current.current);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    move(event);
    drag.current = null;
    setPending(null);
    release(current);
    if (!disabled && (Math.abs(current.current.x - current.start.x) > 1e-8 || Math.abs(current.current.y - current.start.y) > 1e-8)) onChange(current.current);
    dragStateChange.current?.(false);
  };
  const center = pending || visibleCropCenter(crop);
  const left = picture ? picture.left + (center.x - crop.width / 2) * picture.width : 0;
  const top = picture ? picture.top + (center.y - crop.height / 2) * picture.height : 0;
  const width = picture ? crop.width * picture.width : 0;
  const height = picture ? crop.height * picture.height : 0;
  const dragHeight = picture ? Math.max(0, Math.min(height, picture.controlTop - top)) : 0;
  const movable = !disabled && (crop.canMoveX || crop.canMoveY) && dragHeight > 0;

  return <div className="shorts-crop-overlay" ref={layer}>
    {picture && <>
      <div className="shorts-crop-guide" style={{ left, top, width, height }} aria-hidden="true">
        {!movable && <span>{label}</span>}
      </div>
      {movable && <button type="button" className={`shorts-crop-drag ${pending ? "is-dragging" : ""}`}
        style={{ left, top, width, height: dragHeight }} aria-label="Move crop frame" aria-describedby={instructionsId}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home Escape"
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0 || drag.current || !picture) return;
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
          const start = visibleCropCenter(crop);
          drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, start, current: start, crop, picture, target: event.currentTarget };
          event.currentTarget.setPointerCapture(event.pointerId);
          setPending(start);
          dragStateChange.current?.(true);
        }}
        onPointerMove={move} onPointerUp={finish}
        onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) cancel(); }}
        onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancel(); }}
        onKeyDown={event => {
          if (event.key === "Escape") { if (drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); } return; }
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
          event.preventDefault(); cancel();
          const start = visibleCropCenter(crop), step = event.shiftKey ? 0.1 : 0.01;
          const dx = event.key === "ArrowLeft" ? -step * (crop.maxX - crop.minX) : event.key === "ArrowRight" ? step * (crop.maxX - crop.minX) : 0;
          const dy = event.key === "ArrowUp" ? -step * (crop.maxY - crop.minY) : event.key === "ArrowDown" ? step * (crop.maxY - crop.minY) : 0;
          const point = event.key === "Home"
            ? { x: crop.canMoveX ? 0.5 : start.x, y: crop.canMoveY ? 0.5 : start.y }
            : dragCropPoint(crop, start, dx, dy, { width: 1, height: 1 });
          if (point.x !== start.x || point.y !== start.y) onChange(point);
        }}>
        <span className="shorts-crop-grip" aria-hidden="true"><Move size={14} />{width >= 100 && <span>Drag crop</span>}</span>
      </button>}
      <span className="visually-hidden" id={instructionsId}>Drag to move the crop. Arrow keys move a little; Shift and an arrow move farther. Home centers the crop. Escape cancels a drag. Changes apply to every sequence.</span>
    </>}
  </div>;
}
