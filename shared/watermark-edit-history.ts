import type { WatermarkRemoval } from "./watermark-removal.js";

// The ON/OFF switch is not an edit to the saved areas. In particular, Undo
// must never hide retained marks by restoring a disabled snapshot.
export type WatermarkEdit = Omit<WatermarkRemoval, "enabled">;

export function rememberWatermarkEdit(history: WatermarkEdit[], before: WatermarkRemoval, after: WatermarkRemoval, record = true): WatermarkEdit[] {
  if (!record || before.enabled !== after.enabled) return [];
  const { enabled: _beforeEnabled, ...previous } = before;
  const { enabled: _afterEnabled, ...next } = after;
  if (JSON.stringify(previous) === JSON.stringify(next)) return history;
  return [...history.slice(-59), structuredClone(previous)];
}

export function restoreWatermarkEdit(current: WatermarkRemoval, previous: WatermarkEdit): WatermarkRemoval {
  return { ...structuredClone(previous), enabled: current.enabled };
}
