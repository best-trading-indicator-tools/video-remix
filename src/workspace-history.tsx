import { useEffect, useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { Undo2, Redo2 } from "lucide-react";
import { WorkspaceHistory, type HistoryContext } from "../shared/workspace-history";
export const workspaceHistory = new WorkspaceHistory();
export function useWorkspaceState<T>(key: string, initial: T | (() => T), label: string, persist?: (value: T) => void): [T, Dispatch<SetStateAction<T>>, (update: (value: T) => T) => void] {
  workspaceHistory.init(key, initial, persist);
  const value = useSyncExternalStore(workspaceHistory.subscribe, () => workspaceHistory.get<T>(key));
  return [value, useCallback(update => workspaceHistory.set(key, update, label), [key, label]), useCallback(update => workspaceHistory.rebase(key, update), [key])];
}
export function useWorkspaceHistory() { useSyncExternalStore(workspaceHistory.subscribe, workspaceHistory.version); return workspaceHistory; }
const isText = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.tagName === "TEXTAREA" || (target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit"].includes(target.type)));
export function WorkspaceUndo({ disabled, onRestore, onError }: { disabled: boolean; onRestore: (context?: HistoryContext) => void; onError: (message: string) => void }) {
  const history = useWorkspaceHistory();
  const restore = (redo: boolean) => {
    try { const entry = redo ? history.redo() : history.undo(); if (entry) onRestore(entry.context); }
    catch { onError("Undo could not save your presets. Free some browser storage and try again."); }
  };
  useEffect(() => {
    const start = () => { history.flush(); history.group = {}; };
    const end = () => { history.flush(); history.group = undefined; };
    const focus = (event: FocusEvent) => { if (isText(event.target)) start(); };
    const keyUp = (event: KeyboardEvent) => { if (event.target instanceof HTMLInputElement && event.target.type === "range") end(); };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || disabled || isText(event.target) || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const mod = event.metaKey || event.ctrlKey;
      const undo = mod && !event.altKey && event.key.toLowerCase() === "z";
      const redo = mod && !event.altKey && event.key.toLowerCase() === "y";
      if (undo || redo) { event.preventDefault(); restore(redo || event.shiftKey); }
      else if (event.target instanceof HTMLInputElement && event.target.type === "range" && !event.repeat) start();
    };
    document.addEventListener("pointerdown", start, true); document.addEventListener("pointerup", end); document.addEventListener("pointercancel", end);
    document.addEventListener("focusin", focus); document.addEventListener("focusout", end);
    window.addEventListener("keydown", key); window.addEventListener("keyup", keyUp); window.addEventListener("blur", end);
    return () => { document.removeEventListener("pointerdown", start, true); document.removeEventListener("pointerup", end); document.removeEventListener("pointercancel", end); document.removeEventListener("focusin", focus); document.removeEventListener("focusout", end); window.removeEventListener("keydown", key); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", end); };
  });
  return <div className="workspace-undo" role="group" aria-label="Workspace history">
    <button disabled={disabled || !history.undoLabel} onClick={() => restore(false)} title={history.undoLabel ? `Undo: ${history.undoLabel} (⌘/Ctrl+Z)` : "Undo (⌘/Ctrl+Z)"} aria-label={history.undoLabel ? `Undo: ${history.undoLabel}` : "Undo"}><Undo2 size={15} />Undo</button>
    <button disabled={disabled || !history.redoLabel} onClick={() => restore(true)} title={history.redoLabel ? `Redo: ${history.redoLabel} (⌘/Ctrl+Shift+Z)` : "Redo (⌘/Ctrl+Shift+Z)"} aria-label={history.redoLabel ? `Redo: ${history.redoLabel}` : "Redo"}><Redo2 size={15} />Redo</button>
    <span aria-live="polite">{history.undoLabel ? `Last edit: ${history.undoLabel}` : "Changes are reversible"}</span>
  </div>;
}

/** Native menu accelerators otherwise bypass DOM keyboard handlers in Electron. */
export function DesktopHistoryBridge() {
  useEffect(() => window.remixDesktop?.onHistory?.(direction => {
    if (direction !== "undo" && direction !== "redo") return;
    const target = document.activeElement;
    if (isText(target)) { void window.remixDesktop?.editTextHistory(direction); return; }
    (target || window).dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: direction === "redo", bubbles: true, cancelable: true }));
  }), []);
  return null;
}
