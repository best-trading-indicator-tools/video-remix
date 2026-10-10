import { useEffect, useId, useState } from 'react';
import { UPSCALE_LABELS, type Upscale } from '../shared/upscale';
import './upscale.css';

export default function UpscaleControl({ value, onChange, disabled = false }: {
  value?: Upscale; onChange: (value: Upscale) => void; disabled?: boolean;
}) {
  const id = useId();
  const [capability, setCapability] = useState<{ installed: boolean; ready: boolean; device?: string; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/upscale/capabilities', { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('Unavailable');
      return response.json();
    }).then(setCapability).catch(() => {});
    return () => controller.abort();
  }, []);
  return <div className="upscale-control">
    <label htmlFor={id}>AI video upscaler <span>Free · Local</span></label>
    <select id={id} value={value ?? 'off'} disabled={disabled} aria-describedby={`${id}-help`}
      onChange={event => onChange(event.target.value as Upscale)}>
      {(['off', '1080', '1440', '2160'] as const).map(key => <option key={key} value={key}>{UPSCALE_LABELS[key]}</option>)}
    </select>
    <p id={`${id}-help`}>Real-ESRGAN reconstructs detail in smaller main videos. No credits or uploads. Larger originals keep their size.</p>
    {capability?.ready && <p role="status">Ready · {capability.device === 'mps' ? 'Apple GPU' : capability.device === 'cuda' ? 'NVIDIA GPU' : 'CPU · slower, no graphics card needed'}. GPU problems automatically retry on CPU.</p>}
    {capability?.installed === false && <p role="status">{window.remixDesktop ? <>Install the free AI upscaler in <button type="button" className="text-button" onClick={() => { void window.remixDesktop?.openSetup(); }}>Local tools</button>, then return to the editor.</> : <>One-time setup needed on this computer: <code>npm run setup:upscale</code>. Then refresh this page.</>}</p>}
    {capability?.installed && !capability.ready && <p role="status">The upscaler could not pass its startup check. Run <code>npm run check:upscale</code> for details, or <code>npm run setup:upscale</code> to repair it.</p>}
    {value && value !== 'off' && <p>Uses at least {value}px on the shorter edge, overriding Resolution. 4K takes longer and uses more disk space. AI can change fine details; preview a sample first.</p>}
  </div>;
}
