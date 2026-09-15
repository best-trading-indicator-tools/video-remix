import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  Copy,
  Download,
  Expand,
  Film,
  FolderDown,
  Layers3,
  LoaderCircle,
  MonitorPlay,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Settings2,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Subtitles,
  Trash2,
  Upload,
  Volume2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  DEFAULT_SETTINGS,
  randomizeSettings,
  type Attachment,
  type Health,
  type RemixSettings,
  type RenderJob,
  type VideoSource,
} from "../shared/types";

type Preset = { id: string; name: string; settings: RemixSettings };
type Toast = {
  id: number;
  message: string;
  kind: "success" | "error" | "info";
};
const builtinPresets: Preset[] = [
  { id: "original", name: "Original", settings: DEFAULT_SETTINGS },
  {
    id: "clean",
    name: "Clean & crisp",
    settings: {
      ...DEFAULT_SETTINGS,
      contrast: 1.06,
      saturation: 1.05,
      sharpness: 0.45,
    },
  },
  {
    id: "warm",
    name: "Warm editorial",
    settings: {
      ...DEFAULT_SETTINGS,
      temperature: 0.15,
      contrast: 1.04,
      saturation: 0.94,
      brightness: 0.01,
    },
  },
];
const devices = [
  "none",
  "iPhone 17 Pro Max",
  "iPhone 17 Pro",
  "iPhone 17",
  "iPhone 16 Pro Max",
  "iPhone 16 Pro",
  "iPhone 16",
  "iPhone 15 Pro Max",
  "iPhone 15 Pro",
  "iPhone 15",
  "iPhone 14 Pro Max",
  "iPhone 14 Pro",
  "iPhone 14",
  "iPhone 13 Pro Max",
  "iPhone 13 Pro",
  "iPhone 13",
  "Ray-Ban Meta Smart Glasses",
];
const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
function storedObject<T extends object>(key: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as T)
      : fallback;
  } catch {
    return fallback;
  }
}
const initialPresets = (): Preset[] => {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem("remix-presets") || "[]",
    );
    return Array.isArray(value)
      ? value
          .filter(
            (item): item is Preset =>
              typeof item?.id === "string" &&
              typeof item?.name === "string" &&
              !!item?.settings,
          )
          .map((item) => ({
            ...item,
            settings: { ...DEFAULT_SETTINGS, ...item.settings },
          }))
      : [];
  } catch {
    return [];
  }
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      data?.error || `Request failed (${response.status}). Please try again.`,
    );
  return data as T;
}

function IconButton({
  title,
  children,
  onClick,
  disabled,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit = "",
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  hint?: string;
}) {
  const id = `slider-${label.replaceAll(" ", "-").toLowerCase()}`;
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return (
    <div className="slider-field">
      <div className="field-heading">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {value.toFixed(digits)}
          {unit}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={
          {
            "--range-fill": `${((value - min) / (max - min)) * 100}%`,
          } as CSSProperties
        }
      />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  detail,
  value,
  onChange,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-field">
      <span>
        <span className="toggle-title">{label}</span>
        {detail && <span className="field-hint">{detail}</span>}
      </span>
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true" />
    </label>
  );
}

function SelectField({
  label,
  value,
  children,
  onChange,
}: {
  label: string;
  value: string;
  children: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <label className="select-field">
      <span>{label}</span>
      <span className="select-wrap">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {children}
        </select>
        <ChevronDown size={13} />
      </span>
    </label>
  );
}

function Section({
  title,
  icon,
  children,
  trailing,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <section className="control-section">
      <div className="section-heading">
        <h3>
          {icon}
          {title}
        </h3>
        {trailing}
      </div>
      {children}
    </section>
  );
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [connected, setConnected] = useState(true);
  const [sources, setSources] = useState<VideoSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsById, setSettingsById] = useState<
    Record<string, RemixSettings>
  >(() => storedObject("remix-video-settings", {}));
  const [defaultSettings, setDefaultSettings] = useState<RemixSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...storedObject("remix-default-settings", {}),
  }));
  const [attachments, setAttachments] = useState<Record<string, Attachment>>(
    () => storedObject("remix-attachments", {}),
  );
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState<"studio" | "exports">("studio");
  const [tab, setTab] = useState<"essentials" | "color" | "advanced">(
    "essentials",
  );
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [variants, setVariants] = useState(1);
  const [variation, setVariation] = useState(false);
  const [starting, setStarting] = useState(false);
  const [presets, setPresets] = useState<Preset[]>(initialPresets);
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [previewJob, setPreviewJob] = useState<RenderJob | null>(null);
  const [original, setOriginal] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [renderScope, setRenderScope] = useState<"all" | "selected">("all");
  const videoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const subtitleInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileDragDepth = useRef(0);
  const selected =
    sources.find((source) => source.id === selectedId) || sources[0];
  const settings = selected
    ? settingsById[selected.id] || defaultSettings
    : defaultSettings;
  const pending = jobs.filter(
    (job) => job.status === "queued" || job.status === "processing",
  );
  const completed = jobs.filter((job) => job.status === "completed");
  const notify = useCallback(
    (message: string, kind: Toast["kind"] = "info") => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current.slice(-3), { id, message, kind }]);
      window.setTimeout(
        () =>
          setToasts((current) => current.filter((toast) => toast.id !== id)),
        kind === "error" ? 11000 : 5000,
      );
    },
    [],
  );

  useEffect(() => {
    let stopped = false;
    Promise.allSettled([
      api<Health>("/api/health"),
      api<{ sources: VideoSource[] }>("/api/sources"),
    ]).then((results) => {
      if (stopped) return;
      const [healthResult, sourceResult] = results;
      if (healthResult.status === "fulfilled") {
        setHealth(healthResult.value);
        setConnected(true);
      } else {
        setConnected(false);
        notify(
          "Could not connect to the video engine. Check that the server is running.",
          "error",
        );
      }
      if (sourceResult.status === "fulfilled")
        setSources(sourceResult.value.sources);
      else
        notify(
          "Your video library could not be loaded. Refresh to try again.",
          "error",
        );
      setLoading(false);
    });
    return () => {
      stopped = true;
    };
  }, [notify]);

  useEffect(() => {
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let active = false;
      try {
        const data = await api<{ jobs: RenderJob[] }>("/api/jobs");
        if (!stopped) {
          setJobs(data.jobs);
          setConnected(true);
        }
        active = data.jobs.some((job) =>
          ["queued", "processing"].includes(job.status),
        );
      } catch {
        if (!stopped) setConnected(false);
      }
      if (!stopped) timeout = setTimeout(poll, active ? 1000 : 5000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    const healthTimer = setInterval(() => {
      void api<Health>("/api/health")
        .then((value) => {
          if (!stopped) {
            setHealth(value);
            setConnected(true);
          }
        })
        .catch(() => {
          if (!stopped) setConnected(false);
        });
    }, 10000);
    const sourcesTimer = setInterval(() => {
      void api<{ sources: VideoSource[] }>("/api/sources")
        .then((value) => {
          if (!stopped) setSources(value.sources);
        })
        .catch(() => {});
    }, 30000);
    return () => {
      stopped = true;
      clearInterval(healthTimer);
      clearInterval(sourcesTimer);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        "remix-video-settings",
        JSON.stringify(settingsById),
      );
      localStorage.setItem(
        "remix-default-settings",
        JSON.stringify(defaultSettings),
      );
      localStorage.setItem("remix-attachments", JSON.stringify(attachments));
    } catch {
      /* Editing is still available when local storage is disabled. */
    }
  }, [settingsById, defaultSettings, attachments]);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = original ? 1 : settings.speed;
    videoRef.current.volume = original ? 1 : Math.min(1, settings.volume);
    videoRef.current.muted = !original && settings.muted;
  }, [settings.speed, settings.volume, settings.muted, original, selected?.id]);

  useEffect(() => {
    try {
      localStorage.setItem("remix-presets", JSON.stringify(presets));
    } catch {
      /* The app remains usable when browser storage is full. */
    }
  }, [presets]);

  useEffect(() => {
    if (!showHelp && !previewJob) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const getFocusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), video[controls], [tabindex="0"]',
        ) || [],
      );
    getFocusable()[0]?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowHelp(false);
        setPreviewJob(null);
      }
      if (event.key === "Tab") {
        const focusable = getFocusable();
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      document.body.style.overflow = overflow;
      previousFocus?.focus();
    };
  }, [showHelp, previewJob]);

  const updateSettings = (patch: Partial<RemixSettings>) => {
    if (selected)
      setSettingsById((current) => ({
        ...current,
        [selected.id]: { ...settings, ...patch },
      }));
    else setDefaultSettings((current) => ({ ...current, ...patch }));
  };
  const replaceSettings = (value: RemixSettings) =>
    updateSettings({ ...value });
  const applyAll = () => {
    setSettingsById((current) =>
      Object.fromEntries(
        sources.map((source) => [
          source.id,
          {
            ...settings,
            trimStart:
              source.id === selected?.id
                ? settings.trimStart
                : current[source.id]?.trimStart || 0,
            trimEnd:
              source.id === selected?.id
                ? settings.trimEnd
                : (current[source.id]?.trimEnd ?? null),
          },
        ]),
      ),
    );
    setDefaultSettings({ ...settings, trimStart: 0, trimEnd: null });
    notify(
      `Settings applied to ${sources.length} video${sources.length === 1 ? "" : "s"}. Each video's trim is kept.`,
      "success",
    );
  };

  const uploadVideos = (files: File[]) => {
    if (!files.length || uploadProgress !== null) return;
    const maxFiles = health?.maxFiles || 20;
    if (files.length > maxFiles) {
      notify(`Upload up to ${maxFiles} videos at a time.`, "error");
      return;
    }
    const oversized = health
      ? files.find((file) => file.size > health.maxFileSize)
      : null;
    if (oversized) {
      notify(
        `${oversized.name} exceeds the ${formatSize(health!.maxFileSize)} upload limit.`,
        "error",
      );
      return;
    }
    const data = new FormData();
    files.forEach((file) => data.append("videos", file));
    setUploadProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/sources");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      setUploadProgress(null);
      let response: {
        sources?: VideoSource[];
        errors?: { name: string; error: string }[];
        error?: string;
      };
      try {
        response = JSON.parse(xhr.responseText);
      } catch {
        notify("The server returned an unexpected upload response.", "error");
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        notify(response.error || "Upload failed. Please try again.", "error");
        return;
      }
      const added = response.sources || [];
      setSources((current) => [
        ...added,
        ...current.filter(
          (source) => !added.some((item) => item.id === source.id),
        ),
      ]);
      setSettingsById((current) => ({
        ...current,
        ...Object.fromEntries(
          added.map((source) => [source.id, { ...defaultSettings }]),
        ),
      }));
      if (added.length) {
        setSelectedId(added[0].id);
        setView("studio");
        notify(
          `${added.length} video${added.length === 1 ? "" : "s"} added to your workspace.`,
          "success",
        );
      }
      response.errors?.forEach((error) =>
        notify(`${error.name}: ${error.error}`, "error"),
      );
    };
    xhr.onerror = () => {
      setUploadProgress(null);
      notify(
        "Upload interrupted. Check your connection and try again.",
        "error",
      );
    };
    xhr.send(data);
  };

  const removeSource = async (source: VideoSource) => {
    try {
      await api(`/api/sources/${source.id}`, { method: "DELETE" });
      setSources((current) => current.filter((item) => item.id !== source.id));
      if (selected?.id === source.id) setSelectedId(null);
      setSettingsById((current) => {
        const next = { ...current };
        delete next[source.id];
        return next;
      });
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const uploadAttachment = async (file: File, kind: Attachment["kind"]) => {
    if (!selected) return;
    const sourceId = selected.id;
    setAttachmentBusy(kind);
    setAttachmentError(null);
    const data = new FormData();
    data.append("file", file);
    data.append("kind", kind);
    try {
      const attachment = await api<Attachment>("/api/attachments", {
        method: "POST",
        body: data,
      });
      setAttachments((current) => ({
        ...current,
        [attachment.id]: attachment,
      }));
      setSettingsById((current) => ({
        ...current,
        [sourceId]: {
          ...(current[sourceId] || defaultSettings),
          [kind === "audio" ? "audioId" : "subtitleId"]: attachment.id,
        },
      }));
      notify(
        `${kind === "audio" ? "Audio track" : "Subtitles"} attached. Your export will include them.`,
        "success",
      );
    } catch (error) {
      setAttachmentError((error as Error).message);
    } finally {
      setAttachmentBusy(null);
    }
  };

  const startRender = async () => {
    const targets =
      renderScope === "selected" && selected ? [selected] : sources;
    if (!targets.length) return;
    for (const source of targets) {
      const value = settingsById[source.id] || defaultSettings;
      if (
        value.trimStart >= source.duration ||
        (value.trimEnd !== null &&
          (value.trimEnd <= value.trimStart || value.trimEnd > source.duration))
      ) {
        notify(
          `Check the trim points for ${source.name}. The end must follow the start and fit within the video.`,
          "error",
        );
        return;
      }
    }
    setStarting(true);
    try {
      const result = await api<{ jobs: RenderJob[]; batchId: string }>(
        "/api/jobs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: targets.map((source) => ({
              sourceId: source.id,
              settings: settingsById[source.id] || defaultSettings,
            })),
            variants,
            randomize: variation,
          }),
        },
      );
      setJobs((current) => [
        ...result.jobs,
        ...current.filter(
          (job) => !result.jobs.some((added) => added.id === job.id),
        ),
      ]);
      setView("exports");
      notify(
        `${result.jobs.length} export${result.jobs.length === 1 ? "" : "s"} queued. You can keep editing while they render.`,
        "success",
      );
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setStarting(false);
    }
  };

  const jobAction = async (job: RenderJob, action: "cancel" | "retry") => {
    try {
      const result = await api<RenderJob>(`/api/jobs/${job.id}/${action}`, {
        method: "POST",
      });
      setJobs((current) =>
        current.map((item) => (item.id === result.id ? result : item)),
      );
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const clearBatch = async (batchId: string) => {
    try {
      await api(`/api/batches/${batchId}`, { method: "DELETE" });
      setJobs((current) => current.filter((job) => job.batchId !== batchId));
      notify(
        "Export collection cleared. Your source videos are still in the workspace.",
        "success",
      );
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const savePreset = () => {
    if (!presetName.trim()) return;
    setPresets((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: presetName.trim().slice(0, 32),
        settings: {
          ...settings,
          audioId: null,
          subtitleId: null,
          trimStart: 0,
          trimEnd: null,
        },
      },
    ]);
    setPresetName("");
    setSavingPreset(false);
    notify("Preset saved in this browser.", "success");
  };

  const batchGroups = Object.values(
    jobs.reduce<Record<string, RenderJob[]>>((groups, job) => {
      (groups[job.batchId] ||= []).push(job);
      return groups;
    }, {}),
  ).sort((a, b) => b[0].createdAt.localeCompare(a[0].createdAt));
  const edited = Object.keys(DEFAULT_SETTINGS).some(
    (key) =>
      settings[key as keyof RemixSettings] !==
      DEFAULT_SETTINGS[key as keyof RemixSettings],
  );
  const previewFilter = original
    ? "none"
    : `saturate(${settings.saturation}) brightness(${Math.max(0, 1 + settings.brightness)}) contrast(${settings.contrast}) hue-rotate(${settings.hue}deg)`;
  const targetAspect =
    settings.aspect === "original"
      ? selected
        ? `${selected.width} / ${selected.height}`
        : "9 / 16"
      : settings.aspect.replace(":", " / ");
  const exportCount =
    (renderScope === "selected" && selected ? 1 : sources.length) * variants;
  const engineReady = connected && !!health?.ffmpeg && !!health?.ffprobe;

  return (
    <div className="app-shell">
      <header className="site-header">
        <button
          className="brand"
          onClick={() => setView("studio")}
          aria-label="Remix Studio home"
        >
          <span className="brand-mark">
            <Layers3 size={23} strokeWidth={2.25} />
          </span>
          <span>
            remix<span className="brand-light">studio</span>
            <span className="brand-dot">.</span>
          </span>
        </button>
        <nav className="main-nav" aria-label="Main navigation">
          <button
            className={view === "studio" ? "active" : ""}
            onClick={() => setView("studio")}
          >
            <SlidersHorizontal size={15} />
            Workspace
          </button>
          <button
            className={view === "exports" ? "active" : ""}
            onClick={() => setView("exports")}
          >
            <FolderDown size={15} />
            Exports
            {jobs.length > 0 && (
              <span
                className={`nav-count ${pending.length ? "is-working" : ""}`}
              >
                {pending.length || completed.length || jobs.length}
              </span>
            )}
          </button>
        </nav>
        <div className="header-right">
          <span className={`engine-status ${engineReady ? "" : "offline"}`}>
            <span />
            {loading
              ? "Connecting"
              : engineReady
                ? "Local engine ready"
                : "Engine unavailable"}
          </span>
          <button className="help-button" onClick={() => setShowHelp(true)}>
            <CircleHelp size={17} />
            <span>Quick guide</span>
          </button>
        </div>
      </header>

      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">
              <span />
              YOUR FOOTAGE. MORE POSSIBILITIES.
            </div>
            <h1>
              {view === "studio" ? (
                <>
                  Make your next <span>great cut.</span>
                </>
              ) : (
                <>
                  Ready for your <span>next post.</span>
                </>
              )}
            </h1>
            <p>
              {view === "studio"
                ? "Fresh edits, new formats, endless creative possibilities. All in one batch."
                : "Your renders, all together. Download a single cut or the whole collection."}
            </p>
          </div>
          <div className="heading-note">
            <span className="tiny-stack">
              <Film size={17} />
              <Film size={17} />
            </span>
            <span>
              One workspace.
              <br />
              <strong>Every version.</strong>
            </span>
          </div>
        </div>

        {!loading && !engineReady && (
          <div className="connection-banner">
            <CircleHelp size={17} />
            <span>
              {connected
                ? "FFmpeg is not ready. Install FFmpeg, then restart the server to enable video processing."
                : "Connection to the video engine was lost. Your workspace will reconnect automatically."}
            </span>
          </div>
        )}

        {view === "studio" ? (
          <>
            <div className="studio-toolbar">
              <div className="workspace-label">
                <span className="live-dot" />
                Your workspace<span className="muted-divider">/</span>
                <span className="subtle">
                  {sources.length} video{sources.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="toolbar-actions">
                <button
                  onClick={() => {
                    replaceSettings({ ...DEFAULT_SETTINGS });
                    notify("Selected settings reset.", "info");
                  }}
                  disabled={!edited}
                >
                  <RotateCcw size={13} />
                  Reset settings
                </button>
                <span className="toolbar-divider" />
                <button
                  onClick={() => {
                    replaceSettings(randomizeSettings(settings));
                    notify(
                      "A subtle new variation is ready to preview.",
                      "success",
                    );
                  }}
                >
                  <Shuffle size={13} />
                  Surprise me
                </button>
              </div>
            </div>
            <div className="studio-grid">
              <aside className="source-panel panel">
                <div className="panel-heading">
                  <h2>
                    <Layers3 size={16} />
                    Source videos
                  </h2>
                  <span className="count-pill">
                    {sources.length.toString().padStart(2, "0")}
                  </span>
                </div>
                <input
                  ref={videoInput}
                  className="visually-hidden"
                  type="file"
                  multiple
                  accept="video/*,.mkv,.avi,.mov,.mp4,.webm,.m4v"
                  aria-label="Upload videos"
                  onChange={(event) => {
                    uploadVideos(Array.from(event.target.files || []));
                    event.target.value = "";
                  }}
                />
                <button
                  className={`dropzone ${dragging ? "dragging" : ""} ${uploadProgress !== null ? "uploading" : ""}`}
                  disabled={uploadProgress !== null || !connected}
                  onClick={() => videoInput.current?.click()}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    fileDragDepth.current++;
                    setDragging(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    fileDragDepth.current--;
                    if (!fileDragDepth.current) setDragging(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    fileDragDepth.current = 0;
                    setDragging(false);
                    uploadVideos(Array.from(event.dataTransfer.files));
                  }}
                >
                  <span className="upload-icon">
                    {uploadProgress !== null ? (
                      <LoaderCircle size={22} className="spin" />
                    ) : (
                      <Upload size={22} />
                    )}
                  </span>
                  <strong>
                    {uploadProgress === null
                      ? "Drop your videos here"
                      : uploadProgress === 100
                        ? "Preparing your videos…"
                        : `Uploading… ${uploadProgress}%`}
                  </strong>
                  <span>
                    {uploadProgress === null ? (
                      <>
                        or <em>browse files</em>
                      </>
                    ) : (
                      "Keep this window open"
                    )}
                  </span>
                  {uploadProgress === null ? (
                    <small>
                      MP4, MOV, WEBM + more
                      <br />
                      {health
                        ? `${formatSize(health.maxFileSize)} per file · up to ${health.maxFiles} at once`
                        : "Multiple videos welcome"}
                    </small>
                  ) : (
                    <div className="upload-progress">
                      <span style={{ width: `${uploadProgress}%` }} />
                    </div>
                  )}
                </button>
                <div className="source-list">
                  {loading ? (
                    <div className="source-empty">
                      <LoaderCircle size={20} className="spin" />
                      <p>Loading your workspace…</p>
                    </div>
                  ) : sources.length === 0 ? (
                    <div className="source-empty">
                      <div className="empty-queue-icon">
                        <Film size={20} />
                      </div>
                      <strong>A little empty in here.</strong>
                      <p>
                        Add your footage to start
                        <br />
                        making something new.
                      </p>
                      <div className="source-tip">
                        <span>TIP</span>Drop several videos at once.
                        <br />
                        Give each its own settings.
                      </div>
                    </div>
                  ) : (
                    sources.map((source, index) => (
                      <div
                        className={`source-item ${selected?.id === source.id ? "selected" : ""}`}
                        key={source.id}
                      >
                        <button
                          className="source-select"
                          onClick={() => {
                            setSelectedId(source.id);
                            setOriginal(false);
                          }}
                          aria-pressed={selected?.id === source.id}
                        >
                          <div className="source-thumb">
                            <img src={source.thumbnailUrl} alt="" />
                            <span>{duration(source.duration)}</span>
                          </div>
                          <div className="source-info">
                            <span className="source-number">
                              SOURCE{" "}
                              {String(sources.length - index).padStart(2, "0")}
                            </span>
                            <strong title={source.name}>{source.name}</strong>
                            <span>
                              {source.width} × {source.height}
                              <span>·</span>
                              {formatSize(source.size)}
                            </span>
                          </div>
                        </button>
                        <IconButton
                          title={`Remove ${source.name}`}
                          onClick={() => void removeSource(source)}
                          className="remove-source"
                        >
                          <X size={13} />
                        </IconButton>
                      </div>
                    ))
                  )}
                </div>
                <div className="source-footer">
                  <span className="privacy-icon">
                    <Check size={12} />
                  </span>
                  <span>
                    Processed on your machine.
                    <br />
                    <strong>Your footage stays yours.</strong>
                  </span>
                </div>
              </aside>

              <section className="preview-panel panel">
                <div className="panel-heading">
                  <h2>
                    <MonitorPlay size={16} />
                    Preview
                  </h2>
                  <div className="preview-switch">
                    <button
                      disabled={!selected}
                      className={!original ? "active" : ""}
                      onClick={() => setOriginal(false)}
                    >
                      Edited
                    </button>
                    <button
                      disabled={!selected}
                      className={original ? "active" : ""}
                      onClick={() => setOriginal(true)}
                    >
                      Original
                    </button>
                  </div>
                </div>
                <div className={`preview-stage ${selected ? "has-video" : ""}`}>
                  {selected ? (
                    <>
                      <div className="preview-label">
                        <span />
                        {original ? "ORIGINAL FOOTAGE" : "LIVE PREVIEW"}
                      </div>
                      <div
                        className="video-frame"
                        style={{
                          aspectRatio: original
                            ? `${selected.width} / ${selected.height}`
                            : targetAspect,
                        }}
                      >
                        <video
                          key={selected.id}
                          ref={videoRef}
                          src={selected.url}
                          poster={selected.thumbnailUrl}
                          controls
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={() => {
                            if (videoRef.current) {
                              videoRef.current.playbackRate = original
                                ? 1
                                : settings.speed;
                              videoRef.current.currentTime = settings.trimStart;
                            }
                          }}
                          style={{
                            objectFit: original
                              ? "contain"
                              : settings.fit === "crop"
                                ? "cover"
                                : "contain",
                            filter: previewFilter,
                            transform: original
                              ? "none"
                              : `scale(${settings.mirror ? -settings.zoom : settings.zoom}, ${settings.zoom})`,
                          }}
                        />
                        {!original && settings.hookText && (
                          <div className="hook-preview">
                            {settings.hookText}
                          </div>
                        )}
                      </div>
                      <span className="preview-ratio">
                        {original
                          ? `${selected.width} × ${selected.height}`
                          : settings.aspect === "original"
                            ? "ORIGINAL RATIO"
                            : `${settings.aspect} FORMAT`}
                      </span>
                    </>
                  ) : (
                    <div className="preview-empty">
                      <div className="empty-film-art">
                        <div className="art-card art-card-back">
                          <span />
                          <span />
                          <span />
                          <span />
                        </div>
                        <div className="art-card art-card-front">
                          <span />
                          <span />
                          <span />
                          <span />
                          <div className="art-play">
                            <Clapperboard size={35} strokeWidth={1.35} />
                          </div>
                        </div>
                        <span className="art-spark spark-one">✦</span>
                        <span className="art-spark spark-two">+</span>
                        <span className="art-orbit" />
                      </div>
                      <span className="mini-eyebrow">
                        THE NEXT VERSION STARTS HERE
                      </span>
                      <h2>
                        Same footage.
                        <br />
                        <span>New possibilities.</span>
                      </h2>
                      <p>
                        Upload a video, make it your own,
                        <br />
                        and let the studio handle the rest.
                      </p>
                      <button
                        className="outline-button"
                        onClick={() => videoInput.current?.click()}
                        disabled={uploadProgress !== null}
                      >
                        <Plus size={15} />
                        Add your first video
                        <ArrowRight size={14} />
                      </button>
                      <div className="empty-format-tags">
                        <span>9:16</span>
                        <span>1:1</span>
                        <span>4:5</span>
                        <span>16:9</span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="preview-bottom">
                  {selected ? (
                    <>
                      <div className="preview-file">
                        <Film size={15} />
                        <strong title={selected.name}>{selected.name}</strong>
                        <span>{duration(selected.duration)}</span>
                      </div>
                      <div className="preview-note">
                        <CircleHelp size={12} />
                        <span>
                          Approximate preview. Audio, captions and advanced
                          effects appear in your export.
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="preview-bottom-title">
                        <Sparkles size={14} />A fresh take, in three steps
                      </div>
                      <div className="workflow-steps">
                        <span>
                          <b>01</b> Upload
                        </span>
                        <ArrowRight size={12} />
                        <span>
                          <b>02</b> Make it yours
                        </span>
                        <ArrowRight size={12} />
                        <span>
                          <b>03</b> Export
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </section>

              <aside className="settings-panel panel">
                <div className="panel-heading">
                  <h2>
                    <Settings2 size={16} />
                    Make it yours
                  </h2>
                  <span className="settings-state">
                    {edited ? (
                      <>
                        <span />
                        Edited
                      </>
                    ) : (
                      "Original"
                    )}
                  </span>
                </div>
                <div
                  className="settings-tabs"
                  role="tablist"
                  aria-label="Editing controls"
                >
                  {(["essentials", "color", "advanced"] as const).map(
                    (value) => (
                      <button
                        key={value}
                        id={`tab-${value}`}
                        type="button"
                        role="tab"
                        aria-selected={tab === value}
                        aria-controls="settings-content"
                        className={tab === value ? "active" : ""}
                        onClick={() => setTab(value)}
                      >
                        {value === "essentials"
                          ? "Essentials"
                          : value === "color"
                            ? "Color & feel"
                            : "Advanced"}
                      </button>
                    ),
                  )}
                </div>
                <div
                  className="settings-content"
                  id="settings-content"
                  role="tabpanel"
                  aria-labelledby={`tab-${tab}`}
                >
                  {tab === "essentials" && (
                    <>
                      <Section
                        title="Start with a look"
                        icon={<WandSparkles size={13} />}
                        trailing={
                          <button
                            className="text-button"
                            onClick={() => setSavingPreset(!savingPreset)}
                          >
                            <Plus size={11} />
                            Save
                          </button>
                        }
                      >
                        <div className="preset-grid">
                          {[...builtinPresets, ...presets].map((preset) => (
                            <div className="preset-wrap" key={preset.id}>
                              <button
                                className={`preset-chip ${Object.entries(preset.settings).every(([key, value]) => settings[key as keyof RemixSettings] === value) ? "active" : ""}`}
                                onClick={() =>
                                  replaceSettings({
                                    ...preset.settings,
                                    trimStart: settings.trimStart,
                                    trimEnd: settings.trimEnd,
                                    audioId: settings.audioId,
                                    subtitleId: settings.subtitleId,
                                  })
                                }
                              >
                                {preset.id === "original" ? (
                                  <span className="preset-dot original-dot" />
                                ) : (
                                  <span
                                    className={`preset-dot ${preset.id === "warm" ? "warm-dot" : "clean-dot"}`}
                                  />
                                )}
                                {preset.name}
                              </button>
                              {!builtinPresets.some(
                                (item) => item.id === preset.id,
                              ) && (
                                <button
                                  className="delete-preset"
                                  aria-label={`Delete preset ${preset.name}`}
                                  onClick={() =>
                                    setPresets((current) =>
                                      current.filter(
                                        (item) => item.id !== preset.id,
                                      ),
                                    )
                                  }
                                >
                                  <X size={10} />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                        {savingPreset && (
                          <form
                            className="preset-save-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              savePreset();
                            }}
                          >
                            <input
                              autoFocus
                              aria-label="Preset name"
                              placeholder="Name your preset"
                              maxLength={32}
                              value={presetName}
                              onChange={(event) =>
                                setPresetName(event.target.value)
                              }
                            />
                            <button
                              disabled={!presetName.trim()}
                              aria-label="Save preset"
                            >
                              <Check size={16} />
                            </button>
                          </form>
                        )}
                      </Section>
                      <Section
                        title="Frame it right"
                        icon={<Expand size={13} />}
                      >
                        <div className="aspect-options">
                          {(
                            ["original", "9:16", "1:1", "4:5", "16:9"] as const
                          ).map((aspect) => (
                            <button
                              key={aspect}
                              className={
                                settings.aspect === aspect ? "active" : ""
                              }
                              onClick={() => updateSettings({ aspect })}
                            >
                              <span
                                className={`aspect-icon aspect-${aspect.replace(":", "-")}`}
                              />
                              <span>
                                {aspect === "original" ? "Original" : aspect}
                              </span>
                            </button>
                          ))}
                        </div>
                        <div className="fields-row">
                          <SelectField
                            label="Framing"
                            value={settings.fit}
                            onChange={(value) =>
                              updateSettings({
                                fit: value as RemixSettings["fit"],
                              })
                            }
                          >
                            <option value="crop">Fill & crop</option>
                            <option value="contain">Fit entire video</option>
                          </SelectField>
                          <SelectField
                            label="Resolution"
                            value={settings.resolution}
                            onChange={(value) =>
                              updateSettings({
                                resolution:
                                  value as RemixSettings["resolution"],
                              })
                            }
                          >
                            <option value="source">Match source</option>
                            <option value="1080">1080p</option>
                            <option value="720">720p</option>
                          </SelectField>
                        </div>
                        <Slider
                          label="Zoom"
                          value={settings.zoom}
                          min={1}
                          max={2}
                          unit="×"
                          onChange={(zoom) => updateSettings({ zoom })}
                        />
                        <Toggle
                          label="Mirror horizontally"
                          value={settings.mirror}
                          onChange={(mirror) => updateSettings({ mirror })}
                        />
                      </Section>
                      <Section
                        title="Pace & sound"
                        icon={<AudioLines size={14} />}
                      >
                        <Slider
                          label="Playback speed"
                          value={settings.speed}
                          min={0.5}
                          max={2}
                          unit="×"
                          onChange={(speed) => updateSettings({ speed })}
                        />
                        <Slider
                          label="Volume"
                          value={settings.volume}
                          min={0}
                          max={2}
                          unit="×"
                          onChange={(volume) => updateSettings({ volume })}
                        />
                        <Toggle
                          label="Mute audio"
                          value={settings.muted}
                          onChange={(muted) => updateSettings({ muted })}
                        />
                        <input
                          className="visually-hidden"
                          ref={audioInput}
                          type="file"
                          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
                          aria-label="Upload replacement audio"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void uploadAttachment(file, "audio");
                            event.target.value = "";
                          }}
                        />
                        {settings.audioId ? (
                          <div className="attached-file">
                            <AudioLines size={14} />
                            <span>
                              {attachments[settings.audioId]?.name ||
                                "Replacement audio attached"}
                            </span>
                            <IconButton
                              title="Remove replacement audio"
                              onClick={() => updateSettings({ audioId: null })}
                            >
                              <X size={12} />
                            </IconButton>
                          </div>
                        ) : (
                          <button
                            className="attachment-button"
                            disabled={!selected || attachmentBusy !== null}
                            onClick={() => audioInput.current?.click()}
                          >
                            {attachmentBusy === "audio" ? (
                              <LoaderCircle size={13} className="spin" />
                            ) : (
                              <Plus size={13} />
                            )}
                            Add a replacement audio track
                          </button>
                        )}
                        {settings.audioId && settings.muted && (
                          <p className="field-hint accent-hint">
                            Mute is on. Turn it off to hear the replacement
                            track in your export.
                          </p>
                        )}
                        {attachmentError && (
                          <p className="inline-error">{attachmentError}</p>
                        )}
                      </Section>
                    </>
                  )}
                  {tab === "color" && (
                    <>
                      <div className="tab-intro">
                        <span className="small-icon-box">
                          <WandSparkles size={16} />
                        </span>
                        <p>
                          A new mood for your footage.
                          <br />
                          <span>Small adjustments go a long way.</span>
                        </p>
                      </div>
                      <Section title="Light & color">
                        <Slider
                          label="Brightness"
                          value={settings.brightness}
                          min={-1}
                          max={1}
                          onChange={(brightness) =>
                            updateSettings({ brightness })
                          }
                        />
                        <Slider
                          label="Contrast"
                          value={settings.contrast}
                          min={0}
                          max={2}
                          unit="×"
                          onChange={(contrast) => updateSettings({ contrast })}
                        />
                        <Slider
                          label="Saturation"
                          value={settings.saturation}
                          min={0}
                          max={3}
                          unit="×"
                          onChange={(saturation) =>
                            updateSettings({ saturation })
                          }
                        />
                        <Slider
                          label="Temperature"
                          value={settings.temperature}
                          min={-1}
                          max={1}
                          onChange={(temperature) =>
                            updateSettings({ temperature })
                          }
                        />
                        <Slider
                          label="Hue shift"
                          value={settings.hue}
                          min={-180}
                          max={180}
                          step={1}
                          unit="°"
                          onChange={(hue) => updateSettings({ hue })}
                        />
                        <Slider
                          label="Gamma"
                          value={settings.gamma}
                          min={0.1}
                          max={3}
                          onChange={(gamma) => updateSettings({ gamma })}
                        />
                      </Section>
                      <Section title="Texture">
                        <Slider
                          label="Sharpness"
                          value={settings.sharpness}
                          min={0}
                          max={2}
                          onChange={(sharpness) =>
                            updateSettings({ sharpness })
                          }
                        />
                        <Slider
                          label="Film grain"
                          value={settings.noise}
                          min={0}
                          max={1}
                          onChange={(noise) => updateSettings({ noise })}
                        />
                        <Slider
                          label="Blend"
                          value={settings.blend}
                          min={0}
                          max={1}
                          onChange={(blend) => updateSettings({ blend })}
                          hint="Blend neighboring frames for a softer motion effect."
                        />
                      </Section>
                      <button
                        className="secondary-button full-width"
                        onClick={() =>
                          updateSettings({
                            saturation: 1,
                            brightness: 0,
                            contrast: 1,
                            hue: 0,
                            gamma: 1,
                            temperature: 0,
                            noise: 0,
                            sharpness: 0,
                            blend: 0,
                          })
                        }
                      >
                        <RotateCcw size={13} />
                        Reset color & texture
                      </button>
                    </>
                  )}
                  {tab === "advanced" && (
                    <>
                      <Section
                        title="Keep the good part"
                        icon={<Scissors size={13} />}
                      >
                        <div className="fields-row">
                          <label className="number-field">
                            Start (seconds)
                            <input
                              type="number"
                              min={0}
                              max={selected?.duration}
                              step={0.1}
                              value={settings.trimStart}
                              onChange={(event) =>
                                updateSettings({
                                  trimStart: Math.max(
                                    0,
                                    Number(event.target.value),
                                  ),
                                })
                              }
                            />
                          </label>
                          <label className="number-field">
                            End (seconds)
                            <input
                              type="number"
                              min={0}
                              max={selected?.duration}
                              step={0.1}
                              placeholder={
                                selected
                                  ? selected.duration.toFixed(1)
                                  : "Full length"
                              }
                              value={settings.trimEnd ?? ""}
                              onChange={(event) =>
                                updateSettings({
                                  trimEnd:
                                    event.target.value === ""
                                      ? null
                                      : Number(event.target.value),
                                })
                              }
                            />
                          </label>
                        </div>
                        <p className="field-hint">
                          Leave the end blank to keep the rest of the video.
                        </p>
                        <Slider
                          label="Time shift"
                          value={settings.timeShift}
                          min={-5}
                          max={5}
                          step={0.1}
                          unit="s"
                          onChange={(timeShift) =>
                            updateSettings({ timeShift })
                          }
                          hint="Move the trimmed window earlier or later, keeping its length. Set a trim first."
                        />
                        <Slider
                          label="Frame blend"
                          value={settings.frameBlend}
                          min={0}
                          max={0.5}
                          unit="s"
                          onChange={(frameBlend) =>
                            updateSettings({ frameBlend })
                          }
                        />
                      </Section>
                      <Section
                        title="Give it a hook"
                        icon={<Clapperboard size={13} />}
                      >
                        <textarea
                          className="hook-input"
                          aria-label="Opening hook text"
                          placeholder="The part nobody tells you about…"
                          rows={2}
                          value={settings.hookText}
                          maxLength={160}
                          onChange={(event) =>
                            updateSettings({ hookText: event.target.value })
                          }
                        />
                        <div className="hook-meta">
                          <span>Opening text overlay</span>
                          <span>{settings.hookText.length}/160</span>
                        </div>
                        {settings.hookText && (
                          <Slider
                            label="Hook duration"
                            value={settings.hookDuration}
                            min={1}
                            max={15}
                            step={0.5}
                            unit="s"
                            onChange={(hookDuration) =>
                              updateSettings({ hookDuration })
                            }
                          />
                        )}
                      </Section>
                      <Section title="Captions" icon={<Subtitles size={14} />}>
                        <input
                          ref={subtitleInput}
                          className="visually-hidden"
                          type="file"
                          accept=".srt"
                          aria-label="Upload SRT subtitles"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void uploadAttachment(file, "subtitle");
                            event.target.value = "";
                          }}
                        />
                        {settings.subtitleId ? (
                          <div className="attached-file">
                            <Subtitles size={14} />
                            <span>
                              {attachments[settings.subtitleId]?.name ||
                                "SRT subtitles attached"}
                            </span>
                            <IconButton
                              title="Remove subtitles"
                              onClick={() =>
                                updateSettings({ subtitleId: null })
                              }
                            >
                              <X size={12} />
                            </IconButton>
                          </div>
                        ) : (
                          <button
                            className="attachment-button"
                            onClick={() => subtitleInput.current?.click()}
                            disabled={!selected || attachmentBusy !== null}
                          >
                            {attachmentBusy === "subtitle" ? (
                              <LoaderCircle size={14} className="spin" />
                            ) : (
                              <Upload size={14} />
                            )}
                            Upload SRT captions
                          </button>
                        )}
                        <p className="field-hint">
                          Burned into the export. Use timings for your final
                          edited video.
                        </p>
                        {attachmentError && (
                          <p className="inline-error">{attachmentError}</p>
                        )}
                      </Section>
                      <Section
                        title="Export details"
                        icon={<Settings2 size={13} />}
                      >
                        <SelectField
                          label="Frame rate"
                          value={settings.fps}
                          onChange={(value) =>
                            updateSettings({
                              fps: value as RemixSettings["fps"],
                            })
                          }
                        >
                          <option value="source">Match source</option>
                          <option value="24">24 fps</option>
                          <option value="30">30 fps</option>
                          <option value="60">60 fps</option>
                        </SelectField>
                        <Toggle
                          label="Clean file metadata"
                          detail="Remove embedded source metadata."
                          value={settings.stripMetadata}
                          onChange={(stripMetadata) =>
                            updateSettings({ stripMetadata })
                          }
                        />
                        <SelectField
                          label="Device metadata"
                          value={settings.device}
                          onChange={(device) => updateSettings({ device })}
                        >
                          {devices.map((device) => (
                            <option key={device} value={device}>
                              {device === "none" ? "None" : device}
                            </option>
                          ))}
                        </SelectField>
                        <p className="field-hint">
                          Changes file tags only. It does not change the footage
                          or guarantee platform originality.
                        </p>
                      </Section>
                    </>
                  )}
                </div>
                <div className="settings-footer">
                  <button
                    className="apply-all-button"
                    disabled={sources.length < 2}
                    onClick={applyAll}
                  >
                    <Copy size={14} />
                    Apply settings to all videos
                    <span>{sources.length || "—"}</span>
                  </button>
                </div>
              </aside>
            </div>

            <section className="render-bar">
              <div className="render-info">
                <span className="render-icon">
                  <Sparkles size={21} />
                </span>
                <div>
                  <h2>One click. Every cut.</h2>
                  <p>
                    {sources.length
                      ? `${sources.length} source video${sources.length === 1 ? "" : "s"} ready for a fresh take.`
                      : "Add your videos to put the studio to work."}
                  </p>
                </div>
              </div>
              <div className="render-options">
                <div className="version-control">
                  <label htmlFor="versions">Versions per video</label>
                  <div>
                    <button
                      aria-label="Fewer versions"
                      disabled={variants <= 1}
                      onClick={() => setVariants((value) => value - 1)}
                    >
                      −
                    </button>
                    <input
                      id="versions"
                      type="number"
                      min={1}
                      max={5}
                      value={variants}
                      onChange={(event) =>
                        setVariants(
                          Math.min(
                            5,
                            Math.max(
                              1,
                              Math.floor(Number(event.target.value)) || 1,
                            ),
                          ),
                        )
                      }
                    />
                    <button
                      aria-label="More versions"
                      disabled={variants >= 5}
                      onClick={() => {
                        setVariants((value) => value + 1);
                        if (variants === 1) setVariation(true);
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="variation-control">
                  <Toggle
                    label="Subtle variations"
                    value={variation}
                    onChange={setVariation}
                  />
                  <span>
                    {variation
                      ? "Mix up pace, crop & color"
                      : variants > 1
                        ? "Off: versions use identical settings"
                        : "Mix up pace, crop & color"}
                  </span>
                </div>
              </div>
              <div className="render-cta">
                {sources.length > 1 && (
                  <select
                    aria-label="Videos to render"
                    value={renderScope}
                    onChange={(event) =>
                      setRenderScope(event.target.value as "all" | "selected")
                    }
                  >
                    <option value="all">All videos</option>
                    <option value="selected">Selected video</option>
                  </select>
                )}
                <button
                  className="primary-button"
                  disabled={
                    !sources.length ||
                    starting ||
                    !engineReady ||
                    attachmentBusy !== null
                  }
                  onClick={() => void startRender()}
                >
                  {starting ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Sparkles size={17} />
                  )}
                  <span>
                    {starting
                      ? "Preparing exports…"
                      : `Create ${exportCount || ""} ${exportCount === 1 ? "remix" : "remixes"}`}
                  </span>
                  <ArrowRight size={17} />
                </button>
                <span className="render-fineprint">
                  MP4 export · H.264 · Ready to share
                </span>
              </div>
            </section>
          </>
        ) : (
          <section className="exports-panel panel">
            <div className="exports-heading">
              <div>
                <h2>
                  Your exports <span className="count-pill">{jobs.length}</span>
                </h2>
                <p>
                  {pending.length
                    ? `${pending.length} ${pending.length === 1 ? "video is" : "videos are"} rendering. You can keep working in the studio.`
                    : `${completed.length} finished ${completed.length === 1 ? "video" : "videos"} in your collection.`}
                </p>
                <p className="retention-note">
                  Download within {health?.retentionHours || 24} hours. Older
                  files are cleared automatically.
                </p>
              </div>
              <button
                className="secondary-button"
                onClick={() => setView("studio")}
              >
                <ArrowLeft size={14} />
                Back to workspace
              </button>
            </div>
            {!jobs.length ? (
              <div className="exports-empty">
                <span className="large-icon-box">
                  <FolderDown size={32} />
                </span>
                <h2>Your next great cut lives here.</h2>
                <p>
                  Make your edits in the workspace, then create your first
                  remix.
                  <br />
                  Your exports will appear here as they render.
                </p>
                <button
                  className="outline-button"
                  onClick={() => setView("studio")}
                >
                  Open workspace
                  <ArrowRight size={15} />
                </button>
              </div>
            ) : (
              batchGroups.map((batch) => {
                const batchCompleted = batch.filter(
                  (job) => job.status === "completed",
                );
                const batchActive = batch.some((job) =>
                  ["queued", "processing"].includes(job.status),
                );
                return (
                  <div className="batch-group" key={batch[0].batchId}>
                    <div className="batch-heading">
                      <div>
                        <span className="batch-label">EXPORT COLLECTION</span>
                        <h3>
                          {new Date(batch[0].createdAt).toLocaleString(
                            undefined,
                            {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                          )}
                          <span>
                            {batch.length} cut{batch.length === 1 ? "" : "s"}
                          </span>
                        </h3>
                      </div>
                      {batchCompleted.length > 0 && (
                        <a
                          className="secondary-button"
                          href={`/api/batches/${batch[0].batchId}/download`}
                          download
                        >
                          <Download size={14} />
                          {batchActive
                            ? `Download ${batchCompleted.length} ready`
                            : "Download collection"}
                          <span className="zip-tag">ZIP</span>
                        </a>
                      )}
                      {!batchActive && (
                        <IconButton
                          title="Clear export collection"
                          onClick={() => void clearBatch(batch[0].batchId)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      )}
                    </div>
                    <div className="job-list">
                      {batch.map((job) => {
                        const source = sources.find(
                          (source) => source.id === job.sourceId,
                        );
                        return (
                          <article
                            className={`job-card status-${job.status}`}
                            key={job.id}
                          >
                            <div className="job-thumb">
                              {source ? (
                                <img src={source.thumbnailUrl} alt="" />
                              ) : (
                                <Film size={21} />
                              )}
                              {job.status === "processing" && (
                                <span>
                                  <LoaderCircle size={18} className="spin" />
                                </span>
                              )}
                            </div>
                            <div className="job-main">
                              <div className="job-title">
                                <strong title={job.sourceName}>
                                  {job.sourceName}
                                </strong>
                                <span>V{job.variant}</span>
                              </div>
                              <div className="job-details">
                                <span>
                                  {job.settings.aspect === "original"
                                    ? "Original ratio"
                                    : job.settings.aspect}
                                </span>
                                <span>·</span>
                                <span>
                                  {job.settings.speed.toFixed(2)}× speed
                                </span>
                                <span>·</span>
                                <span>
                                  {job.outputSize
                                    ? formatSize(job.outputSize)
                                    : "MP4"}
                                </span>
                              </div>
                              {job.status === "processing" && (
                                <div className="job-progress">
                                  <span
                                    style={{
                                      width: `${Math.max(1, Math.min(100, job.progress))}%`,
                                    }}
                                  />
                                </div>
                              )}
                              {job.error && (
                                <p className="job-error">{job.error}</p>
                              )}
                            </div>
                            <div className="job-status">
                              {job.status === "completed" ? (
                                <>
                                  <Check size={12} />
                                  Ready
                                </>
                              ) : job.status === "processing" ? (
                                <>
                                  <span className="live-dot" />
                                  {Math.round(job.progress)}%
                                </>
                              ) : (
                                job.status.charAt(0).toUpperCase() +
                                job.status.slice(1)
                              )}
                            </div>
                            <div className="job-actions">
                              {job.status === "completed" && job.downloadUrl ? (
                                <>
                                  <IconButton
                                    title={`Preview ${job.sourceName} version ${job.variant}`}
                                    onClick={() => setPreviewJob(job)}
                                  >
                                    <MonitorPlay size={17} />
                                  </IconButton>
                                  <a
                                    className="download-button"
                                    href={job.downloadUrl}
                                    download
                                    aria-label={`Download ${job.sourceName} version ${job.variant}`}
                                  >
                                    <ArrowDownToLine size={16} />
                                    <span>Download</span>
                                  </a>
                                </>
                              ) : job.status === "failed" ||
                                job.status === "cancelled" ? (
                                <button
                                  className="secondary-button"
                                  onClick={() => void jobAction(job, "retry")}
                                >
                                  <RefreshCw size={13} />
                                  Retry
                                </button>
                              ) : (
                                <IconButton
                                  title={`Cancel ${job.sourceName} version ${job.variant}`}
                                  onClick={() => void jobAction(job, "cancel")}
                                >
                                  <X size={17} />
                                </IconButton>
                              )}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        )}

        <footer className="site-footer">
          <span>
            <span className="footer-mark">r.</span>A little less repetitive. A
            lot more creative.
          </span>
          <span>
            Made for your own & licensed footage
            <span className="footer-dot">·</span>
            <button onClick={() => setShowHelp(true)}>
              How it works
              <ArrowRight size={12} />
            </button>
          </span>
        </footer>
      </main>
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast ${toast.kind}`} key={toast.id}>
            {toast.kind === "success" ? (
              <CheckCheck size={17} />
            ) : (
              <CircleHelp size={17} />
            )}
            <span>{toast.message}</span>
            <IconButton
              title="Dismiss notification"
              onClick={() =>
                setToasts((current) =>
                  current.filter((item) => item.id !== toast.id),
                )
              }
            >
              <X size={14} />
            </IconButton>
          </div>
        ))}
      </div>
      {previewJob && (
        <div className="modal-backdrop" onClick={() => setPreviewJob(null)}>
          <section
            className="export-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Export preview: ${previewJob.sourceName}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">
                  YOUR FINISHED CUT · VERSION {previewJob.variant}
                </span>
                <h2 title={previewJob.sourceName}>{previewJob.sourceName}</h2>
              </div>
              <IconButton
                title="Close export preview"
                onClick={() => setPreviewJob(null)}
              >
                <X size={20} />
              </IconButton>
            </div>
            <video
              src={`/api/jobs/${previewJob.id}/video`}
              controls
              playsInline
              autoPlay
            />
            <div className="export-preview-footer">
              <span>Final render, with all edits applied.</span>
              <a
                className="secondary-button"
                href={previewJob.downloadUrl}
                download
              >
                <Download size={14} />
                Download MP4
              </a>
            </div>
          </section>
        </div>
      )}
      {showHelp && (
        <div className="modal-backdrop" onClick={() => setShowHelp(false)}>
          <section
            className="help-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Quick guide"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <span className="eyebrow">A QUICK TOUR</span>
              <IconButton
                title="Close guide"
                onClick={() => setShowHelp(false)}
              >
                <X size={20} />
              </IconButton>
            </div>
            <h2>Meet your remix studio.</h2>
            <p>
              Turn the footage you have into the next version worth sharing.
            </p>
            <ol className="guide-steps">
              <li>
                <span>01</span>
                <div>
                  <h3>Bring your footage</h3>
                  <p>
                    Upload several videos at once. Select a video in the sidebar
                    to give it its own edit.
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>Make something fresh</h3>
                  <p>
                    Change the framing, pace and color. Add an opening hook,
                    your own audio, and SRT captions. Save favorite looks as
                    browser presets.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>Export every version</h3>
                  <p>
                    Create up to five versions per video. Switch on subtle
                    variations for a different mix of pace, crop and color in
                    each. Download individual MP4s or a collection ZIP.
                  </p>
                </div>
              </li>
            </ol>
            <div className="guide-note">
              <h3>A couple of good things to know</h3>
              <p>
                The preview approximates framing and basic color. Captions,
                replacement audio, timed text and advanced filters are rendered
                into the export. Metadata controls only change file tags; they
                do not guarantee originality or reach on social platforms.
              </p>
              <p>
                Download your exports within {health?.retentionHours || 24}{" "}
                hours; older files are automatically cleaned up.
              </p>
              <p>
                Processing runs on the computer hosting this app. Use your own
                footage or material you have permission to repurpose.
              </p>
            </div>
            <button
              className="primary-button full-width"
              onClick={() => setShowHelp(false)}
            >
              Let's make a great cut
              <ArrowRight size={16} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
