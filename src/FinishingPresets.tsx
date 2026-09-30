import ProblemNotice from "./ProblemNotice";
import { useEffect, useId, useState } from "react";
import { Bookmark, Check, Trash2 } from "lucide-react";
import { captureFinishingPreset, FINISHING_PRESET_EVENT, FINISHING_PRESET_STORAGE, migrateManualPresets, restoreFinishingPresets, type FinishingPreset, type PresetMode, type PresetValues } from "../shared/finishing-presets";
import "./finishing-presets.css";
const load = () => {
  try {
    const saved = localStorage.getItem(FINISHING_PRESET_STORAGE);
    return saved ? restoreFinishingPresets(JSON.parse(saved)) : migrateManualPresets(JSON.parse(localStorage.getItem("remix-presets") || "[]"));
  } catch { return []; }
};
const descriptions = {
  auto: "Saves format, pacing, caption handling, and supporting-visual preferences. Length, versions, narration, and selected library clips stay with each video.",
  manual: "Saves framing, color, audio level, captions, and supporting-visual preferences. Cuts, playback speed, text, and uploaded media stay with this video.",
  shorts: "Saves format, layout, tracking method, and cleanup. Each short keeps its own timestamps and subject positions.",
};
export default function FinishingPresets<M extends PresetMode>({ mode, settings, disabled, onApply, onApplySelected }: {
  mode: M; settings: unknown; disabled?: boolean; onApply: (settings: PresetValues[M]) => void;
  onApplySelected?: (settings: PresetValues[M]) => void;
}) {
  const [presets, setPresets] = useState(load);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const id = useId();
  useEffect(() => {
    const update = () => setPresets(load());
    window.addEventListener("storage", update); window.addEventListener(FINISHING_PRESET_EVENT, update);
    return () => { window.removeEventListener("storage", update); window.removeEventListener(FINISHING_PRESET_EVENT, update); };
  }, []);
  const items = presets.filter(preset => preset.mode === mode);
  const current = items.find(preset => preset.id === selected);
  const persist = (next: FinishingPreset[]) => {
    try {
      localStorage.setItem(FINISHING_PRESET_STORAGE, JSON.stringify({ version: 1, presets: next }));
      setPresets(next); window.dispatchEvent(new Event(FINISHING_PRESET_EVENT)); setError(""); return true;
    } catch { setError("Browser storage is full or unavailable. This preset was not saved."); return false; }
  };
  const save = () => {
    try {
      const fresh = load();
      if (fresh.length >= 60) throw new Error("You have 60 presets. Delete one before saving another.");
      const preset = captureFinishingPreset(mode, name, settings, crypto.randomUUID());
      if (persist([...fresh, preset])) { setSelected(preset.id); setName(""); setMessage(`Saved “${preset.name}” in this browser.`); }
    } catch (error) { setError(error instanceof Error && error.message.startsWith("You have") ? error.message : "Enter a name and check your current settings before saving."); }
  };
  const apply = (selectedShorts = false) => {
    if (!current) return;
    (selectedShorts ? onApplySelected : onApply)?.(structuredClone(current.settings) as PresetValues[M]);
    setMessage(`Applied “${current.name}”${selectedShorts ? " to selected shorts" : ""}.`); setError("");
  };
  return <details className="finishing-presets">
    <summary><Bookmark size={14} />Finishing presets<span>{items.length ? `${items.length} saved` : "Save your style"}</span></summary>
    <div className="finishing-preset-body">
      <p>{descriptions[mode]}</p>
      {!!items.length && <><label htmlFor={`${id}-choose`}>Saved preset</label><div className="finishing-preset-select"><select id={`${id}-choose`} value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose a preset</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" className="icon-button" aria-label="Delete selected finishing preset" disabled={!current || disabled} onClick={() => { if (persist(load().filter(item => item.id !== selected))) { setSelected(""); setMessage("Preset deleted."); } }}><Trash2 size={15} /></button></div>
        {current && <div className="finishing-preset-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={() => apply()}>Apply to this {mode === "shorts" ? "short" : "video"}</button>{onApplySelected && <button type="button" className="secondary-button" disabled={disabled} onClick={() => apply(true)}>Apply to selected shorts</button>}</div>}</>}
      <label htmlFor={`${id}-name`}>Save current finish as</label><div className="finishing-preset-select"><input id={`${id}-name`} value={name} maxLength={60} placeholder="e.g. Clean podcast portrait" onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (name.trim() && !disabled) save(); } }} /><button type="button" className="secondary-button" disabled={disabled || !name.trim()} onClick={save}><Check size={14} />Save</button></div>
      {message && <p className="finishing-preset-message" role="status">{message}</p>}{error && <ProblemNotice message={error} operation="Save finishing preset" />}
    </div>
  </details>;
}
