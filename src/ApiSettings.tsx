import { useEffect, useState } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import { API_PROVIDERS, type ApiKeySettings, type ApiProvider } from "../shared/api-keys";
import { apiRequest } from "./api-client";

const providers: Record<ApiProvider, { name: string; description: string }> = {
  deepseek: { name: "DeepSeek", description: "Prompt edits, hooks, visual matching and reviews. We chose DeepSeek for its much lower cost than many proprietary LLM APIs. This is a paid API; usage is billed to your account." },
  pixabay: { name: "Pixabay", description: "Free stock videos and animations with a free API key. Provider usage limits apply." },
  pexels: { name: "Pexels", description: "Free stock videos with a free API key. Provider usage limits apply." },
  postiz: { name: "Postiz", description: "Schedule and publish exports to your connected channels." },
};
const blankKeys = (): Record<ApiProvider, string> => ({ deepseek: "", pixabay: "", pexels: "", postiz: "" });
const endpoint = "/api/settings/api-keys";

export default function ApiSettings({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<ApiKeySettings | null>(null);
  const [keys, setKeys] = useState(blankKeys);
  const [busy, setBusy] = useState<ApiProvider | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void apiRequest<ApiKeySettings>(endpoint, { signal: controller.signal })
      .then(setSettings)
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [reload]);

  const save = async (provider: ApiProvider, remove = false) => {
    setBusy(provider); setError(""); setNotice("");
    try {
      const updated = await apiRequest<ApiKeySettings>(`${endpoint}/${provider}`, {
        method: remove ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json", "X-Remix-Settings": "1" },
        ...(!remove ? { body: JSON.stringify({ apiKey: keys[provider].trim() }) } : {}),
      });
      setSettings(updated);
      setKeys(current => ({ ...current, [provider]: "" }));
      const status = updated.providers.find(item => item.provider === provider)!;
      setNotice(remove
        ? status.source === "environment" ? `${providers[provider].name} is using your environment key again.` : `${providers[provider].name} saved key removed.`
        : `${providers[provider].name} key saved. New requests will use it.`);
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save your API key. Try again."); }
    finally { setBusy(null); }
  };

  return <section className="api-settings" aria-label="API keys">
    <div className="api-settings-intro">
      <KeyRound size={20} aria-hidden="true" />
      <div><h2>Your API keys</h2><p>Saved keys are encrypted on this computer. Your existing environment keys stay intact.</p></div>
    </div>
    {error && <div className="api-settings-error" role="alert">{error}{!settings && <button className="text-button" onClick={() => setReload(value => value + 1)}>Try again</button>}</div>}
    <p className="api-settings-notice" role="status">{notice}</p>
    {!settings && !error && <p className="api-settings-loading" role="status"><LoaderCircle size={16} className="spin" />Loading API settings…</p>}
    {settings && <div className="api-keys-grid">{API_PROVIDERS.map(provider => {
      const details = providers[provider];
      const status = settings.providers.find(item => item.provider === provider)!;
      const configured = status.source !== "none";
      return <form className="api-key-card panel" key={provider} onSubmit={event => { event.preventDefault(); void save(provider); }}>
        <div className="api-key-heading"><h3>{details.name}</h3><span className={`api-key-status ${configured ? "configured" : ""}`}>
          {status.source === "settings" ? "Saved key" : status.source === "environment" ? "Environment key" : "Not configured"}
        </span></div>
        <p>{details.description}</p>
        <label htmlFor={`api-key-${provider}`}>{details.name} API key</label>
        <input id={`api-key-${provider}`} name={`api-key-${provider}`} type="password"
          autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={4096}
          placeholder={configured ? "Key configured · enter a replacement" : "Paste your API key"}
          value={keys[provider]} disabled={Boolean(busy)}
          onChange={event => { setKeys(current => ({ ...current, [provider]: event.target.value })); setNotice(""); }} />
        <div className="api-key-actions">
          <button type="submit" className="secondary-button" disabled={Boolean(busy) || !keys[provider].trim()}>
            {busy === provider ? <><LoaderCircle size={14} className="spin" />Saving…</> : "Save key"}
          </button>
          {status.source === "settings" && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => void save(provider, true)}>
            {status.hasEnvironmentKey ? "Use environment key" : "Remove saved key"}
          </button>}
        </div>
      </form>;
    })}</div>}
  </section>;
}
