import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, Compass, X } from "lucide-react";
import { rememberOnboarding, TOUR_STEPS, INTRO_STEPS, type TourDestination } from "./onboarding-steps";
import "./onboarding.css";

type Rect = { left: number; top: number; width: number; height: number };
export default function OnboardingTour({ onNavigate, onClose, initialTopic }: {
  initialTopic?: string;
  onNavigate: (destination: TourDestination) => void;
  onClose: () => void;
}) {
  const [detailed, setDetailed] = useState(Boolean(initialTopic));
  const [index, setIndex] = useState(() => initialTopic ? Math.max(0, TOUR_STEPS.findIndex(step => step.id === initialTopic)) : 0);
  const steps = detailed ? TOUR_STEPS : INTRO_STEPS;
  const [target, setTarget] = useState<Rect | null>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const card = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const step = steps[index];
  const last = index === steps.length - 1;

  useEffect(() => {
    rememberOnboarding();
    const previousFocus = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    const wasHidden = root?.getAttribute("aria-hidden");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (root) { root.inert = true; root.setAttribute("aria-hidden", "true"); }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== "Tab") return;
      const elements = Array.from(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, [tabindex="0"]') || [])
        .filter(element => element.checkVisibility());
      const first = elements[0], end = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); end?.focus();
      } else if (!event.shiftKey && (document.activeElement === end || !elements.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => {
      window.removeEventListener("keydown", keyboard, true);
      document.body.style.overflow = overflow;
      if (root) {
        root.inert = wasInert;
        if (wasHidden == null) root.removeAttribute("aria-hidden"); else root.setAttribute("aria-hidden", wasHidden);
      }
      const focus = previousFocus?.isConnected && previousFocus !== document.body
        ? previousFocus : document.querySelector<HTMLElement>('[aria-label="Quick guide"]');
      focus?.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    setTarget(null);
    if (step.destination) onNavigate(step.destination);
    if (card.current) card.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
    let frame = 0, disposed = false, element: HTMLElement | null = null;
    const opened = new Map<HTMLDetailsElement, boolean>();
    const reveal = (details: HTMLDetailsElement) => {
      if (!opened.has(details)) opened.set(details, details.open);
      details.open = true;
    };
    const viewport = window.visualViewport;
    const measure = () => {
      if (disposed) return;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
      const raw = element?.isConnected && element.checkVisibility() ? element.getBoundingClientRect() : null;
      const compact = width < 900 || height < 600;
      const cardHeight = Math.min(card.current?.getBoundingClientRect().height || 450, height - 24);
      if (!raw) {
        setTarget(null);
        setPosition({ left: left + width / 2, top: top + height / 2, transform: "translate(-50%, -50%)", maxHeight: height - 24 });
        return;
      }
      let visibleTop = top + 8, visibleBottom = top + height - 8;
      if (compact) {
        const above = raw.top - top, below = top + height - raw.bottom;
        const atTop = above > below && above > height * 0.25;
        // Near the end of a page, scrolling cannot lift the target any higher.
        // Put the card above it and preserve the remaining space for the control.
        const available = atTop ? above - 24 : below - 24;
        const maximum = Math.max(160, Math.min(Math.floor(height * 0.58), available > 160 ? available : height));
        setPosition({ left: left + 12, top: atTop ? top + 12 : top + height - Math.min(cardHeight, maximum) - 12,
          width: width - 24, maxHeight: maximum });
        if (atTop) visibleTop = top + Math.min(cardHeight, maximum) + 24;
        else visibleBottom = top + height - Math.min(cardHeight, maximum) - 24;
      } else {
        const cardWidth = Math.min(400, width - 48);
        const placeLeft = raw.left + raw.width / 2 > left + width / 2;
        setPosition({ left: placeLeft ? left + 24 : left + width - cardWidth - 24,
          top: Math.max(top + 24, Math.min(raw.top, top + height - cardHeight - 24)), width: cardWidth, maxHeight: height - 48 });
      }
      const x = Math.max(left + 4, raw.left - 6), y = Math.max(visibleTop, raw.top - 6);
      const right = Math.min(left + width - 4, raw.right + 6), bottom = Math.min(visibleBottom, raw.bottom + 6);
      setTarget(right > x && bottom > y ? { left: x, top: y, width: right - x, height: bottom - y } : null);
    };
    const observer = new ResizeObserver(measure);
    const locate = (attempt = 0) => {
      if (disposed) return;
      element = step.target ? document.querySelector<HTMLElement>(step.target) : null;
      if (step.reveal) document.querySelectorAll<HTMLDetailsElement>(step.reveal).forEach(reveal);
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement) reveal(ancestor);
      }
      // Wait for App to switch views and React to mount the selected controls.
      if (step.target && (!element || !element.checkVisibility()) && attempt < 12) {
        frame = requestAnimationFrame(() => locate(attempt + 1));
        return;
      }
      // Draft/export controls do not exist in an empty workspace. Still show
      // where they will appear without creating sample media or changing edits.
      if ((!element || !element.checkVisibility()) && step.fallbackTarget) {
        element = document.querySelector<HTMLElement>(step.fallbackTarget);
      }
      if (element?.checkVisibility()) {
        element.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
        window.scrollBy({ top: -24, behavior: "instant" });
        observer.observe(element);
      }
      if (card.current) observer.observe(card.current);
      measure();
    };
    frame = requestAnimationFrame(() => locate());
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      for (const [details, open] of opened) if (details.isConnected) details.open = open;
    };
  }, [step, onNavigate]);

  return createPortal(<div className={`onboarding-overlay ${target ? "has-target" : ""}`}>
    <div className="onboarding-dismiss-area" aria-hidden="true" onClick={onClose} />
    {target && <div className="onboarding-spotlight" style={target} aria-hidden="true" />}
    <section ref={card} className="onboarding-card" style={position} role="dialog" aria-modal="true"
      aria-labelledby="onboarding-title" aria-describedby="onboarding-description" data-step={step.id}>
      <header className="onboarding-header">
        <span><Compass size={17} /> STUDIO TOUR</span>
        <div><button type="button" className="onboarding-skip" onClick={onClose}>Skip tour</button>
          <button type="button" className="onboarding-close" aria-label="Close tour" onClick={onClose}><X size={18} /></button></div>
      </header>
      <div className="onboarding-content">
        <div className="onboarding-progress-label"><span>{step.chapter}</span><span role="status">{index + 1} of {steps.length}</span></div>
        <progress max={steps.length} value={index + 1} aria-label="Tour progress" />
        <h2 ref={heading} id="onboarding-title" tabIndex={-1}>{step.title}</h2>
        <p id="onboarding-description">{step.description}</p>
        <dl>{step.options.map(([label, description]) => <div key={label}><dt>{label}</dt><dd>{description}</dd></div>)}</dl>
        {detailed ? <label className="onboarding-topics">Jump to topic
          <select value={index} onChange={event => setIndex(Number(event.target.value))}>
            {Array.from(new Set(TOUR_STEPS.map(item => item.chapter))).map(chapter => <optgroup label={chapter} key={chapter}>
              {TOUR_STEPS.map((item, position) => item.chapter === chapter
                ? <option key={item.id} value={position}>{position + 1}. {item.title}</option> : null)}
            </optgroup>)}
          </select>
        </label> : <button className="text-button" onClick={() => { setDetailed(true); setIndex(0); }}>Browse all help topics</button>}
      </div>
      <footer className="onboarding-footer">
        <button type="button" className="secondary-button" disabled={index === 0} onClick={() => setIndex(value => value - 1)}><ArrowLeft size={15} />Back</button>
        <button type="button" className="primary-button" onClick={() => last ? onClose() : setIndex(value => value + 1)}>
          {last ? <>Finish tour<Check size={15} /></> : <>Next<ArrowRight size={15} /></>}
        </button>
      </footer>
    </section>
  </div>, document.body);
}
