import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, LoaderCircle } from "lucide-react";
import { API_PROVIDERS, type ApiConnectionResult, type ApiKeySettings, type ApiProvider } from "../shared/api-keys";
import { apiRequest } from "./api-client";

const providers: Record<ApiProvider, { name: string; description: string; url: string; link: string; help: string }> = {
  deepseek: { name: "DeepSeek", description: "Prompt edits, hooks, visual matching and reviews. We chose DeepSeek for its much lower cost than many proprietary LLM APIs. This is a paid API; usage is billed to your account.", url: "https://platform.deepseek.com/api_keys", link: "Open DeepSeek · create a key", help: "Create an account, add a small balance, then copy your API key." },
  pixabay: { name: "Pixabay", description: "Free stock videos and animations with a free API key. Provider usage limits apply.", url: "https://pixabay.com/api/docs/", link: "Get a free Pixabay key", help: "Sign in to Pixabay to see your key in the API documentation. Stock matching also needs DeepSeek." },
  pexels: { name: "Pexels", description: "Free stock videos with a free API key. Provider usage limits apply.", url: "https://www.pexels.com/api/", link: "Open Pexels · API access", help: "Use your Pexels API key. If new keys are unavailable, start with Pixabay. Stock matching also needs DeepSeek." },
  postiz: { name: "Postiz", description: "Schedule and publish exports to your connected channels.", url: "https://docs.postiz.com/public-api", link: "Get a Postiz API key", help: "Optional: only needed for scheduling. Copy the key from your Postiz account settings." },
};
const blankKeys = (): Record<ApiProvider, string> => ({ deepseek: "", pixabay: "", pexels: "", postiz: "" });
const endpoint = "/api/settings/api-keys";

export default function ApiSettings({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<ApiKeySettings | null>(null);
  const [keys, setKeys] = useState(blankKeys);
  const [busy, setBusy] = useState<ApiProvider | null>(null);
  const [testing, setTesting] = useState<ApiProvider | null>(null);
  const [checks, setChecks] = useState<Partial<Record<ApiProvider, ApiConnectionResult>>>({});
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
      if (remove) setChecks(current => ({ ...current, [provider]: undefined }));
      setKeys(current => ({ ...current, [provider]: "" }));
      const status = updated.providers.find(item => item.provider === provider)!;
      setNotice(remove
        ? status.source === "environment" ? `${providers[provider].name} is using your environment key again.` : `${providers[provider].name} saved key removed.`
        : `${providers[provider].name} key saved. New requests will use it.`);
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save your API key. Try again."); }
    finally { setBusy(null); }
  };

  const testConnection = async (provider: ApiProvider) => {
    setTesting(provider); setError("");
    setChecks(current => ({ ...current, [provider]: undefined }));
    try {
      const apiKey = keys[provider].trim();
      const result = await apiRequest<ApiConnectionResult>(`${endpoint}/${provider}/test`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Remix-Settings": "1" },
        body: JSON.stringify(apiKey ? { apiKey } : {}),
      });
      setChecks(current => ({ ...current, [provider]: result }));
    } catch { setChecks(current => ({ ...current, [provider]: { status: "unavailable", message: "Connection check failed. Try again.", checkedAt: new Date().toISOString() } })); }
    finally { setTesting(null); }
  };
  const working = Boolean(busy || testing);

  return <section className="api-settings" aria-label="API keys">
    {window.remixDesktop && <div className="desktop-tools-card panel"><div><h2>Local tools</h2><p>Install or repair captions, the AI upscaler and other free local features.</p></div>
      <button type="button" className="secondary-button" onClick={() => { void window.remixDesktop?.openSetup().catch(() => setError("Could not open Local tools. Restart Remix Studio.")); }}>Open Local tools</button></div>}
    <div className="api-settings-intro">
      <KeyRound size={20} aria-hidden="true" />
      <div><h2>Your API keys</h2><p>1. Get a key → 2. Paste and test → 3. Save. Saved keys are encrypted on this computer.</p>
        <p>Connection tests check account access without generating AI content, uploading footage or publishing posts. Stock checks use one search request.</p></div>
    </div>
    {error && <div className="api-settings-error" role="alert">{error}{!settings && <button className="text-button" onClick={() => setReload(value => value + 1)}>Try again</button>}</div>}
    <p className="api-settings-notice" role="status">{notice}</p>
    {!settings && !error && <p className="api-settings-loading" role="status"><LoaderCircle size={16} className="spin" />Loading API settings…</p>}
    {settings && <div className="api-keys-grid">{API_PROVIDERS.map(provider => {
      const details = providers[provider];
      const status = settings.providers.find(item => item.provider === provider)!;
      const configured = status.source !== "none";
      const check = checks[provider];
      const unsaved = Boolean(keys[provider].trim());
      return <form className="api-key-card panel" key={provider} onSubmit={event => { event.preventDefault(); void save(provider); }}>
        <div className="api-key-heading"><h3>{details.name}</h3><span className={`api-key-status ${configured ? "configured" : ""}`}>
          {testing === provider ? "Checking…" : check?.status === "ready" ? unsaved ? "Key works · save to use" : "Ready" : check ? "Needs attention" : configured ? "Not tested" : "Not configured"}
        </span></div>
        <p>{details.description}</p>
        <a className="api-key-link" href={details.url} target="_blank" rel="noreferrer">{details.link}<ExternalLink size={13} aria-hidden="true" /></a>
        <p className="api-key-help">{details.help}</p>
        <label htmlFor={`api-key-${provider}`}>{details.name} API key</label>
        <input id={`api-key-${provider}`} name={`api-key-${provider}`} type="password"
          autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={4096}
          placeholder={configured ? "Key configured · enter a replacement" : "Paste your API key"}
          value={keys[provider]} disabled={working}
          onChange={event => { setKeys(current => ({ ...current, [provider]: event.target.value })); setChecks(current => ({ ...current, [provider]: undefined })); setNotice(""); }} />
        <div className="api-key-actions">
          <button type="button" className="secondary-button" disabled={working || (!configured && !unsaved)} onClick={() => void testConnection(provider)}>
            {testing === provider ? <><LoaderCircle size={14} className="spin" />Testing…</> : "Test connection"}
          </button>
          <button type="submit" className="secondary-button" disabled={working || !unsaved}>
            {busy === provider ? <><LoaderCircle size={14} className="spin" />Saving…</> : "Save key"}
          </button>
          {status.source === "settings" && <button type="button" className="text-button" disabled={working} onClick={() => void save(provider, true)}>
            {status.hasEnvironmentKey ? "Use environment key" : "Remove saved key"}
          </button>}
        </div>
        {check && <p className={`api-connection-result ${check.status === "ready" ? "ready" : "attention"}`} role="status">
          {check.status === "ready" && <CheckCircle2 size={15} aria-hidden="true" />}<span>{check.message}{unsaved && check.status === "ready" && " Click Save key to use it."}
            <small>Checked {new Date(check.checkedAt).toLocaleTimeString()}</small></span>
        </p>}
      </form>;
    })}</div>}
  </section>;
}
