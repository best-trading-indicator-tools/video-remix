import { useEffect, useMemo, useRef, useState } from 'react';

/** Whole-draft history: one entry per committed gesture, including server retiming. */
export function useEditHistory<T>(value: T | null, identity: string) {
  const entries = useRef<T[]>([]), cursor = useRef(-1), previous = useRef(''), restoring = useRef(false);
  const [, update] = useState(0);
  useEffect(() => { entries.current = []; cursor.current = -1; previous.current = ''; }, [identity]);
  const serialized = useMemo(() => value === null ? '' : JSON.stringify(value), [value]);
  useEffect(() => {
    if (value === null || serialized === previous.current) return;
    previous.current = serialized;
    if (restoring.current) { restoring.current = false; return; }
    entries.current = [...entries.current.slice(0, cursor.current + 1), structuredClone(value)].slice(-100);
    cursor.current = entries.current.length - 1; update(count => count + 1);
  }, [serialized, identity]);
  const travel = (delta: number): T | undefined => {
    const next = cursor.current + delta;
    if (next < 0 || next >= entries.current.length) return;
    cursor.current = next; restoring.current = true; update(count => count + 1);
    return structuredClone(entries.current[next]!);
  };
  return { canUndo: cursor.current > 0, canRedo: cursor.current < entries.current.length - 1, undo: () => travel(-1), redo: () => travel(1) };
}
