import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";

export default function SourceList({ children, hasSources }: { children: ReactNode; hasSources: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ horizontal: false, before: false, after: false });
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const horizontal = element.scrollWidth > element.clientWidth + 2;
      const position = horizontal ? element.scrollLeft : element.scrollTop;
      const remaining = horizontal ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
      const next = { horizontal, before: position > 2, after: remaining - position > 2 };
      setScroll(previous => previous.horizontal === next.horizontal && previous.before === next.before && previous.after === next.after ? previous : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => { observer.disconnect(); element.removeEventListener("scroll", measure); };
  }, [children]);
  const move = (direction: number) => {
    const element = list.current;
    if (!element) return;
    const distance = direction * (scroll.horizontal ? element.clientWidth : element.clientHeight) * 0.8;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    element.scrollBy(scroll.horizontal ? { left: distance, behavior } : { top: distance, behavior });
  };
  return <div className="source-browser">
    <div id="source-video-list" ref={list} className="source-list" role="region" aria-label="Imported videos" tabIndex={hasSources ? 0 : undefined}>
      {children}
    </div>
    {hasSources && (scroll.before || scroll.after) && <div className="source-scroll-controls" aria-label="Browse more source videos">
      {scroll.before && <button type="button" aria-controls="source-video-list" onClick={() => move(-1)}>
        {scroll.horizontal ? <ArrowLeft size={14} /> : <ArrowUp size={14} />}Previous videos
      </button>}
      {scroll.after && <button type="button" aria-controls="source-video-list" onClick={() => move(1)}>
        {scroll.horizontal ? "More videos" : "More videos below"}{scroll.horizontal ? <ArrowRight size={14} /> : <ArrowDown size={14} />}
      </button>}
    </div>}
  </div>;
}
