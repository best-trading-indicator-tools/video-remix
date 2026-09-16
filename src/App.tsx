import OwnFootagePanel from "./OwnFootagePanel";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
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
  Clock3,
  Clapperboard,
  Copy,
  Download,
  Expand,
  Film,
  FolderDown,
  History,
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
  DEFAULT_AUTO_OPTIONS,
  DEFAULT_BROLL_COUNT,
  DEFAULT_SETTINGS,
  MAX_AUTO_VERSIONS,
  isAutoTargetDuration,
  MAX_BROLL_COUNT,
  randomizeSettings,
  type AutoCapabilities,
  type AutoOptions,
  type Attachment,
  type Health,
  type RemixSettings,
  type RenderJob,
  type VideoSource,
} from "../shared/types";
import AutoPanel, { AUTO_FORMAT_NAMES } from "./AutoPanel";
import EditPlanEditor, { QualityReportSummary } from "./EditPlanEditor";
import EditorialReportSummary from "./EditorialReportSummary";
import JobRecoveryNotice from "./JobRecoveryNotice";
import HistoryPanel from "./HistoryPanel";
import Slider from "./Slider";
import ImportPanel from "./ImportPanel";
import LongFormPanel from "./LongFormPanel";
import ManualPromptEditor from "./ManualPromptEditor";
import FinishingPresets from "./FinishingPresets";
import { compactBrollNotes } from "../shared/broll-notes";
import { getVisualSources, hasLibraryVisuals, hasStockVisuals, VISUAL_SOURCE_LABELS } from "../shared/visual-sources";
import { MANUAL_LOOKS, applyColorLook, activeColorLook, manualPreviewInterval, manualSequencePreview, manualCropPosition } from "../shared/manual";

type AutoPreset = { options: AutoOptions; variants: number };
const visualSourceSummary = (options: AutoOptions) => getVisualSources(options).map((source) => VISUAL_SOURCE_LABELS[source]).join(" + ") || "Original footage only";
function autoPreset(value?: Partial<AutoPreset>): AutoPreset {
  const options = value?.options;
  return {
    variants: Math.max(
      1,
      Math.min(MAX_AUTO_VERSIONS, Math.floor(Number(value?.variants)) || 1),
    ),
    options: {
      ...DEFAULT_AUTO_OPTIONS,
      ...options,
      aspect: ["original", "9:16", "1:1", "4:5", "16:9"].includes(
        options?.aspect || "",
      )
        ? options!.aspect
        : DEFAULT_AUTO_OPTIONS.aspect,
      targetDuration: isAutoTargetDuration(options?.targetDuration)
        ? options!.targetDuration
        : DEFAULT_AUTO_OPTIONS.targetDuration,
      narration: options?.narration === true,
      captions: options?.captions === "add" || options?.captions === "keep" ? options.captions : "auto",
      editorialMode: options?.editorialMode === "off" || options?.editorialMode === "check" ? options.editorialMode : "repair",
      visualSources: getVisualSources(options),
      supportingVisuals: [
        "off",
        "stock",
        "library",
        "graphics",
        "both",
      ].includes(options?.supportingVisuals || "")
        ? options!.supportingVisuals
        : "off",
      brollMatching: options?.brollMatching === "ai" ? "ai" : "tags",
      brollMaxCoverage: typeof options?.brollMaxCoverage === "number" && Number.isInteger(options.brollMaxCoverage) && options.brollMaxCoverage >= 0 && options.brollMaxCoverage <= 100
        ? options.brollMaxCoverage : DEFAULT_AUTO_OPTIONS.brollMaxCoverage,
      brollCount:
        typeof options?.brollCount === "number" &&
        Number.isInteger(options.brollCount) &&
        options.brollCount >= 1 &&
        options.brollCount <= MAX_BROLL_COUNT
          ? options.brollCount
          : DEFAULT_BROLL_COUNT,
      stockVideoType:
        options?.stockVideoType === "animation" ? "animation" : "all",
      brollIds: Array.isArray(options?.brollIds)
        ? [...new Set(options.brollIds.filter((id) => typeof id === "string"))]
        : [],
    },
  };
}
function sameAutoPreset(first: AutoPreset, second: AutoPreset): boolean {
  return (
    JSON.stringify({
      ...first,
      options: {
        ...first.options,
        supportingVisuals: undefined,
        visualSources: getVisualSources(first.options),
        brollIds: [...(first.options.brollIds || [])].sort(),
      },
    }) ===
    JSON.stringify({
      ...second,
      options: {
        ...second.options,
        supportingVisuals: undefined,
        visualSources: getVisualSources(second.options),
        brollIds: [...(second.options.brollIds || [])].sort(),
      },
    })
  );
}
type Toast = {
  id: number;
  message: string;
  kind: "success" | "error" | "info";
};
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
  const [mode, setMode] = useState<"auto" | "manual" | "shorts">("auto");
  const [autoById, setAutoById] = useState<Record<string, AutoPreset>>(() =>
    Object.fromEntries(
      Object.entries(
        storedObject<Record<string, AutoPreset>>(
          "remix-auto-video-settings",
          {},
        ),
      ).map(([id, value]) => [id, autoPreset(value)]),
    ),
  );
  const [defaultAuto, setDefaultAuto] = useState<AutoPreset>(() =>
    autoPreset(storedObject("remix-auto-default-settings", {})),
  );
  const [autoCapabilities, setAutoCapabilities] =
    useState<AutoCapabilities | null>(null);
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
  const [brollBusy, setBrollBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState<string | null>(null);
  const [view, setView] = useState<"studio" | "exports" | "history">("studio");
  const [historySource, setHistorySource] = useState<VideoSource | null>(null);
  const [tab, setTab] = useState<"essentials" | "color" | "advanced" | "all">(
    "essentials",
  );
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [editorialRetries, setEditorialRetries] = useState<Record<string, { pending: boolean; error: string }>>({});
  const editorialRequests = useRef(new Set<string>());
  const [variants, setVariants] = useState(1);
  const [variation, setVariation] = useState(false);
  const [starting, setStarting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [previewJob, setPreviewJob] = useState<RenderJob | null>(null);
  const [editingJob, setEditingJob] = useState<RenderJob | null>(null);
  const [original, setOriginal] = useState(false);
  const [renderedPreview, setRenderedPreview] = useState<{ id: string; url: string; duration: number; signature: string } | null>(null);
  const [showRendered, setShowRendered] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [manualPreviewError, setManualPreviewError] = useState("");
  const [liveOutputTime, setLiveOutputTime] = useState(0);
  const previewRequest = useRef<AbortController | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [renderScope, setRenderScope] = useState<"all" | "selected">("all");
  const [autoRenderScope, setAutoRenderScope] = useState<"all" | "current" | "selected">("all");
  const [autoSelectedIds, setAutoSelectedIds] = useState<string[]>([]);
  const videoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const subtitleInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const selected =
    sources.find((source) => source.id === selectedId) || sources[0];
  const autoTargets = autoRenderScope === "current" ? (selected ? [selected] : []) :
    autoRenderScope === "selected" ? sources.filter((source) => autoSelectedIds.includes(source.id)) : sources;
  const settings = selected
    ? settingsById[selected.id] || defaultSettings
    : defaultSettings;
  const selectedAuto = selected
    ? autoById[selected.id] || defaultAuto
    : defaultAuto;
  const autoOptions = selectedAuto.options;
  const autoPresets = sources.map(
    (source) => autoById[source.id] || defaultAuto,
  );
  const uniformAuto = autoPresets.every((preset) =>
    sameAutoPreset(preset, selectedAuto),
  );
  const sourcePreview = mode === "auto" || original;
  const previewSignature = JSON.stringify({ sourceId: selected?.id, settings });
  const previewCurrent = renderedPreview?.signature === previewSignature;
  const usingRendered = mode === "manual" && !original && showRendered && previewCurrent;
  const sequencePreview = selected ? manualSequencePreview(settings, selected.duration) : null;
  const liveInterval = sequencePreview?.first ?? (selected && (settings.trimEnd === null || settings.trimEnd <= selected.duration)
    ? manualPreviewInterval(settings, selected.duration) : null);
  const pending = jobs.filter(
    (job) => job.status === "queued" || job.status === "processing",
  );
  const completed = jobs.filter((job) => job.status === "completed");
  useEffect(() => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreviewBusy(false);
    setManualPreviewError("");
    return () => { previewRequest.current?.abort(); };
  }, [previewSignature, mode, view]);

  const renderManualPreview = async () => {
    if (!selected || previewRequest.current) return;
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewBusy(true);
    setManualPreviewError("");
    try {
      const result = await api<{ id: string; url: string; duration: number }>("/api/previews", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ sourceId: selected.id, settings }),
      });
      if (!controller.signal.aborted) {
        setRenderedPreview({ ...result, signature: previewSignature });
        setOriginal(false);
        setShowRendered(true);
      }
    } catch (error) {
      if (!controller.signal.aborted) setManualPreviewError(error instanceof Error ? error.message : "Preview failed. Please try again.");
    } finally {
      if (previewRequest.current === controller) { previewRequest.current = null; setPreviewBusy(false); }
    }
  };
  useEffect(() => {
    window.scrollTo(0, 0);
    if (view !== "studio") videoRef.current?.pause();
  }, [view]);
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
    const check = () =>
      api<AutoCapabilities>("/api/auto/capabilities")
        .then((value) => {
          if (stopped) return;
          setAutoCapabilities(value);
        })
        .catch(() => {
          if (!stopped)
            setAutoCapabilities({
              transcription: false,
              model: "",
              intelligence: false,
              narration: false,
              message:
                "Automatic editing tools could not be checked. The engine will try available local tools when you start.",
            });
        });
    void check();
    const timer = setInterval(() => void check(), 30000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

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
    try {
      localStorage.setItem(
        "remix-auto-video-settings",
        JSON.stringify(autoById),
      );
      localStorage.setItem(
        "remix-auto-default-settings",
        JSON.stringify(defaultAuto),
      );
    } catch {
      /* Per-video editing remains available without browser storage. */
    }
  }, [autoById, defaultAuto]);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = sourcePreview || usingRendered ? 1 : settings.speed;
    videoRef.current.volume = sourcePreview || usingRendered ? 1 : Math.min(1, settings.volume);
    videoRef.current.muted = !sourcePreview && !usingRendered && settings.muted;
  }, [
    settings.speed,
    settings.volume,
    settings.muted,
    sourcePreview,
    usingRendered,
    selected?.id,
  ]);

  useEffect(() => {
    if (!videoRef.current || usingRendered || sourcePreview || !liveInterval) return;
    videoRef.current.currentTime = liveInterval.start;
    setLiveOutputTime(0);
  }, [liveInterval?.start, liveInterval?.end, usingRendered, sourcePreview, selected?.id]);


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
  const replaceSettings = (value: RemixSettings) => {
    if (selected) setSettingsById((current) => ({ ...current, [selected.id]: { ...DEFAULT_SETTINGS, ...value } }));
    else setDefaultSettings({ ...DEFAULT_SETTINGS, ...value });
  };
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

  const updateAuto = (patch: Partial<AutoPreset>) => {
    if (selected) {
      const sourceId = selected.id;
      setAutoById((current) => ({
        ...current,
        [sourceId]: autoPreset({
          ...(current[sourceId] || defaultAuto),
          ...patch,
        }),
      }));
    } else setDefaultAuto((current) => autoPreset({ ...current, ...patch }));
  };
  const applyAutoAll = () => {
    setAutoById((current) => ({
      ...current,
      ...Object.fromEntries(
        sources.map((source) => [source.id, autoPreset(selectedAuto)]),
      ),
    }));
    setDefaultAuto(autoPreset(selectedAuto));
    notify(
      `Auto settings applied to all ${sources.length} videos and saved for new imports.`,
      "success",
    );
  };
  const removeBrollSelection = (assetId: string) => {
    const remove = (preset: AutoPreset) => ({
      ...preset,
      options: {
        ...preset.options,
        brollIds: preset.options.brollIds?.filter((id) => id !== assetId),
      },
    });
    setAutoById((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, preset]) => [id, remove(preset)]),
      ),
    );
    setDefaultAuto(remove);
  };

  const importedSources = (added: VideoSource[]) => {
    setSources(current => [...added, ...current.filter(source => !added.some(item => item.id === source.id))]);
    setSettingsById(current => ({ ...current, ...Object.fromEntries(added.filter(source => !current[source.id]).map(source => [source.id, { ...defaultSettings }])) }));
    setAutoById(current => ({ ...current, ...Object.fromEntries(added.filter(source => !current[source.id]).map(source => [source.id, autoPreset(defaultAuto)])) }));
    if (added.length) setSelectedId(current => current || added[0].id);
  };

  const removeSource = async (source: VideoSource) => {
    try {
      await api(`/api/sources/${source.id}`, { method: "DELETE" });
      setSources((current) => current.filter((item) => item.id !== source.id));
      setAutoSelectedIds((current) => current.filter((id) => id !== source.id));
      if (selected?.id === source.id) setSelectedId(null);
      setSettingsById((current) => {
        const next = { ...current };
        delete next[source.id];
        return next;
      });
      setAutoById((current) => {
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
    if (mode === "auto") {
      if (!autoTargets.length) return;
      setStarting(true);
      try {
        const result = await api<{ jobs: RenderJob[]; batchId: string }>(
          "/api/auto/jobs",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: autoTargets.map((source) => {
                const preset = autoById[source.id] || defaultAuto;
                return {
                  sourceId: source.id,
                  variants: preset.variants,
                  options: { ...preset.options, visualSources: getVisualSources(preset.options) },
                };
              }),
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
          `${autoTargets.length} video${autoTargets.length === 1 ? "" : "s"} queued for automatic editing. Follow each cut below.`,
          "success",
        );
      } catch (error) {
        notify((error as Error).message, "error");
      } finally {
        setStarting(false);
      }
      return;
    }
    const targets =
      renderScope === "selected" && selected ? [selected] : sources;
    if (!targets.length) return;
    for (const source of targets) {
      const value = settingsById[source.id] || defaultSettings;
      if (value.segments ? !manualSequencePreview(value, source.duration) : (
        value.trimStart >= source.duration ||
        (value.trimEnd !== null &&
          (value.trimEnd <= value.trimStart || value.trimEnd > source.duration))
      )) {
        notify(
          `Check the ${value.segments ? "source cuts" : "trim points"} for ${source.name}. Each end must follow its start and fit within the video.`,
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

  const retryEditorialReview = async (job: RenderJob) => {
    if (editorialRequests.current.has(job.id)) return;
    editorialRequests.current.add(job.id);
    setEditorialRetries((current) => ({ ...current, [job.id]: { pending: true, error: "" } }));
    try {
      const result = await api<RenderJob>(`/api/jobs/${job.id}/editorial-review`, { method: "POST" });
      setJobs((current) => current.map((item) => item.id === result.id ? result : item));
      setPreviewJob((current) => current?.id === result.id ? result : current);
      setEditorialRetries((current) => ({ ...current, [job.id]: { pending: false, error: "" } }));
    } catch (error) {
      setEditorialRetries((current) => ({ ...current, [job.id]: { pending: false, error: (error as Error).message } }));
    } finally {
      editorialRequests.current.delete(job.id);
    }
  };

  const clearBatch = async (batchId: string) => {
    try {
      await api(`/api/batches/${batchId}`, { method: "DELETE" });
      setJobs((current) => current.filter((job) => job.batchId !== batchId));
      notify(
        "Export files removed. Source videos and History records are kept.",
        "success",
      );
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const batchGroups = Object.values(
    jobs.reduce<Record<string, RenderJob[]>>((groups, job) => {
      (groups[job.batchId] ||= []).push(job);
      return groups;
    }, {}),
  ).sort((a, b) => b[0].createdAt.localeCompare(a[0].createdAt));
  const manualDefaults = { ...DEFAULT_SETTINGS, normalizeAudio: false, autoMotion: false, qualityCleanup: false, focalPoint: { x: 0.5, y: 0.5 }, captionStyle: { fontSize: 20, bottomPercent: 100 / 12 } };
  const adjustedCount = Object.entries(manualDefaults).filter(([key, value]) =>
    JSON.stringify(settings[key as keyof RemixSettings] ?? value) !== JSON.stringify(value),
  ).length;
  const edited = adjustedCount > 0;
  const previewFilter = sourcePreview
    ? "none"
    : `saturate(${settings.saturation}) brightness(${Math.max(0, 1 + settings.brightness)}) contrast(${settings.contrast}) hue-rotate(${settings.hue}deg)`;
  const targetAspect =
    settings.aspect === "original"
      ? selected
        ? `${selected.width} / ${selected.height}`
        : "9 / 16"
      : settings.aspect.replace(":", " / ");
  const exportCount =
    mode === "auto"
      ? autoTargets.reduce((total, source) => total + (autoById[source.id] || defaultAuto).variants, 0)
      : (renderScope === "selected" && selected ? 1 : sources.length) *
        variants;
  const engineReady = connected && !!health?.ffmpeg && !!health?.ffprobe;
  const missingBrollSources =
    mode === "auto"
      ? autoTargets.filter((source) => {
          const options = (autoById[source.id] || defaultAuto).options;
          return (
            hasLibraryVisuals(options) && getVisualSources(options).length === 1 &&
            !options.brollIds?.length
          );
        })
      : [];
  const noBrollSelected = missingBrollSources.length > 0;

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
                {pending.length || completed.length}
              </span>
            )}
          </button>
          <button className={`history-nav-button ${view === "history" ? "active" : ""}`} aria-label="History" title="History" onClick={() => { setHistorySource(null); setView("history"); }}>
            <History size={15} />History
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
          <button
            className="help-button"
            aria-label="Quick guide"
            onClick={() => setShowHelp(true)}
          >
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
              REMIX STUDIO / YOUR CREATIVE WORKSPACE
            </div>
            <h1>
              {view === "studio" ? (
                <>
                  {mode === "auto" ? (
                    <>
                      Good footage. <span>A sharper story.</span>
                    </>
                  ) : mode === "shorts" ? (
                    <>Long stories. <span>Great short clips.</span></>
                  ) : (
                    <>
                      Make your next <span>great cut.</span>
                    </>
                  )}
                </>
              ) : view === "history" ? (
                <>Your work, <span>in perspective.</span></>
              ) : (
                <>
                  Ready for your <span>next post.</span>
                </>
              )}
            </h1>
            <p>
              {view === "studio"
                ? mode === "auto"
                  ? "Find a focused excerpt, shape the edit, and refine every detail before your next post."
                  : mode === "shorts" ? "Choose precise moments from your long videos, join sequences, and export each short in Full HD."
                  : "Shape the frame, dial in your look, and make every version your own."
                : view === "history" ? "Find previously used excerpts and keep track of the videos you have posted."
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

        <div hidden={view !== "studio"} style={{ display: view === "studio" ? undefined : "none" }}>
            <div className="studio-toolbar">
              <div className="workspace-label">
                <span className="live-dot" />
                Your workspace<span className="muted-divider">/</span>
                <span className="subtle">
                  {sources.length} video{sources.length === 1 ? "" : "s"}
                </span>
              </div>
              <div
                className="mode-switch"
                role="group"
                aria-label="Editing mode"
              >
                <button
                  aria-pressed={mode === "auto"}
                  className={mode === "auto" ? "active" : ""}
                  onClick={() => setMode("auto")}
                >
                  <Sparkles size={13} />
                  Auto remix
                </button>
                <button
                  aria-pressed={mode === "manual"}
                  className={mode === "manual" ? "active" : ""}
                  onClick={() => setMode("manual")}
                >
                  <SlidersHorizontal size={13} />
                  Manual
                </button>
                <button aria-pressed={mode === "shorts"} className={mode === "shorts" ? "active" : ""} onClick={() => setMode("shorts")}><Scissors size={13} />Short clips</button>
              </div>
              {mode === "manual" && (
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
              )}
            </div>
            <div
              className={`studio-grid ${mode === "auto" ? "auto-studio" : mode === "shorts" ? "shorts-studio" : tab === "all" ? "manual-all-controls" : ""}`}
            >
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
                <ImportPanel health={health} connected={connected} inputRef={videoInput}
                  onImported={importedSources} onBusyChange={busy => setUploadProgress(busy ? 0 : null)}
                  onError={message => notify(message, "error")} />
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
                        {mode === "auto" && <label className="auto-source-check" title={`Include ${source.name} in selected videos`}>
                          <input type="checkbox" aria-label={`Select ${source.name} for Auto rendering`} checked={autoSelectedIds.includes(source.id)} disabled={starting || brollBusy}
                            onChange={(event) => {
                              setAutoSelectedIds((current) => event.target.checked ? [...current, source.id] : current.filter((id) => id !== source.id));
                              setAutoRenderScope("selected");
                            }} />
                        </label>}
                        <button
                          className="source-select"
                          onClick={() => {
                            setSelectedId(source.id);
                            setOriginal(false);
                          }}
                          aria-pressed={selected?.id === source.id}
                          disabled={brollBusy}
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
                            {mode === "auto" && (
                              <span className="source-auto-preset">
                                {(autoById[source.id] || defaultAuto).options
                                  .aspect === "original"
                                  ? "Original"
                                  : (autoById[source.id] || defaultAuto).options
                                      .aspect}
                                <span>·</span>
                                Up to{" "}
                                {
                                  (autoById[source.id] || defaultAuto).options
                                    .targetDuration
                                }
                                s<span>·</span>
                                {
                                  (autoById[source.id] || defaultAuto).variants
                                }{" "}
                                max
                              </span>
                            )}
                            {mode === "auto" && <span className="source-visual-sources" title={visualSourceSummary((autoById[source.id] || defaultAuto).options)}>
                              {visualSourceSummary((autoById[source.id] || defaultAuto).options)}
                            </span>}
                          </div>
                        </button>
                        <IconButton
                          title={`Remove ${source.name}`}
                          disabled={brollBusy}
                          onClick={() => void removeSource(source)}
                          className="remove-source"
                        >
                          <X size={13} />
                        </IconButton>
                      </div>
                    ))
                  )}
                </div>
                {mode === "auto" && selected && (selected.previousExports || 0) > 0 && <button className="source-history-notice" onClick={() => { setHistorySource(selected); setView("history"); }}>
                  <strong>{selected.name}</strong>Previously exported {selected.previousExports} {selected.previousExports === 1 ? "edit" : "edits"} · See History
                </button>}
                <div className="source-footer">
                  <span className="privacy-icon">
                    <Check size={12} />
                  </span>
                  <span>
                    {autoPresets.some(
                      (preset) =>
                        preset.options.brollMatching === "ai" &&
                        (hasStockVisuals(preset.options) || hasLibraryVisuals(preset.options)),
                    ) ? (
                      <>
                        Videos render on your machine.
                        <br />
                        <strong>
                          AI matching shares sample frames &amp; text.
                        </strong>
                      </>
                    ) : (
                      <>
                        Processed on your machine.
                        <br />
                        <strong>Your footage stays yours.</strong>
                      </>
                    )}
                  </span>
                </div>
              </aside>

              <LongFormPanel active={view === "studio" && mode === "shorts"} sources={sources} selectedSource={selected} engineReady={engineReady} onSelectSource={setSelectedId} onNotice={notify} onQueued={(added) => {
                setJobs(current => [...added, ...current.filter(job => !added.some(item => item.id === job.id))]);
                setView("exports");
              }} />
              {mode !== "shorts" && <>
              <section className="preview-panel panel">
                <div className="panel-heading">
                  <h2>
                    <MonitorPlay size={16} />
                    {mode === "auto" ? "Your footage" : "Preview"}
                  </h2>
                  {mode === "manual" && (
                    <div className="preview-switch">
                      <button
                        disabled={!selected}
                        className={!original && !usingRendered ? "active" : ""}
                        onClick={() => { setOriginal(false); setShowRendered(false); }}
                      >
                        Live
                      </button>
                      <button
                        disabled={!selected}
                        className={original ? "active" : ""}
                        onClick={() => setOriginal(true)}
                      >
                        Original
                      </button>
                      {previewCurrent && <button className={usingRendered ? "active" : ""} onClick={() => { setOriginal(false); setShowRendered(true); }}>Rendered</button>}
                    </div>
                  )}
                </div>
                <div className={`preview-stage ${selected ? "has-video" : ""}`}>
                  {selected ? (
                    <>
                      <div className="preview-label">
                        <span />
                        {sourcePreview ? "ORIGINAL FOOTAGE" : usingRendered ? "RENDERED SAMPLE" : sequencePreview ? "LIVE · FIRST CUT" : "LIVE PREVIEW"}
                      </div>
                      <div
                        className="video-frame"
                        style={{
                          aspectRatio: sourcePreview
                            ? `${selected.width} / ${selected.height}`
                            : targetAspect,
                        }}
                      >
                        <video
                          key={usingRendered ? renderedPreview!.id : selected.id}
                          ref={videoRef}
                          src={usingRendered ? renderedPreview!.url : selected.url}
                          poster={usingRendered ? undefined : selected.thumbnailUrl}
                          controls
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={() => {
                            if (videoRef.current) {
                              videoRef.current.playbackRate = sourcePreview || usingRendered
                                ? 1
                                : settings.speed;
                              videoRef.current.volume = sourcePreview || usingRendered ? 1 : Math.min(1, settings.volume);
                              videoRef.current.muted = !sourcePreview && !usingRendered && settings.muted;
                              videoRef.current.currentTime = sourcePreview || usingRendered
                                ? 0
                                : liveInterval?.start ?? 0;
                            }
                          }}
                          onPlay={(event) => {
                            if (!sourcePreview && !usingRendered && liveInterval && event.currentTarget.currentTime >= liveInterval.end - 0.04)
                              event.currentTarget.currentTime = liveInterval.start;
                          }}
                          onSeeking={(event) => {
                            if (!sourcePreview && !usingRendered && liveInterval) {
                              const video = event.currentTarget;
                              if (video.currentTime < liveInterval.start) video.currentTime = liveInterval.start;
                              if (video.currentTime > liveInterval.end) video.currentTime = liveInterval.end;
                            }
                          }}
                          onTimeUpdate={(event) => {
                            if (!sourcePreview && !usingRendered && liveInterval) {
                              const video = event.currentTarget;
                              setLiveOutputTime(Math.max(0, video.currentTime - liveInterval.start) / settings.speed);
                              if (video.currentTime >= liveInterval.end - 0.025 && !video.paused) { video.pause(); video.currentTime = liveInterval.end; }
                            }
                          }}
                          onError={() => {
                            if (usingRendered) { setShowRendered(false); setRenderedPreview(null); setManualPreviewError("This preview is no longer available. Render a fresh sample."); }
                          }}
                          style={{
                            objectFit: sourcePreview || usingRendered
                              ? "contain"
                              : settings.fit === "crop"
                                ? "cover"
                                : "contain",
                            objectPosition: sourcePreview || usingRendered || settings.fit !== "crop" ? "50% 50%" : manualCropPosition(selected.width, selected.height, settings.aspect === "original" ? selected.width / selected.height : Number(settings.aspect.split(":")[0]) / Number(settings.aspect.split(":")[1]), sequencePreview?.cuts[0]?.focalPoint ?? settings.focalPoint ?? { x: 0.5, y: 0.5 }),
                            filter: usingRendered ? "none" : previewFilter,
                            transform: sourcePreview || usingRendered
                              ? "none"
                              : `scale(${settings.mirror ? -settings.zoom : settings.zoom}, ${settings.zoom})`,
                          }}
                        />
                        {!sourcePreview && !usingRendered && settings.hookText && liveOutputTime < settings.hookDuration && (
                          <div className="hook-preview">
                            {settings.hookText}
                          </div>
                        )}
                      </div>
                      <span className="preview-ratio">
                        {sourcePreview
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
                          {mode === "auto"
                            ? "Your original source. The finished remix will be ready to preview in Exports."
                            : usingRendered ? "Rendered sample with your effects, text and audio. Preview quality is capped at 720p."
                            : sequencePreview ? "Live shows the first cut. Render a sample to review the sequence with your effects, text and audio."
                            : "Live framing and basic color. Render a short sample to see every effect, text and audio."}
                        </span>
                      </div>
                      {mode === "manual" && <>
                        <div className="manual-preview-actions">
                          <p>{previewBusy ? "Rendering a short sample on your machine…" : usingRendered ? `${renderedPreview!.duration.toFixed(1)}s from the start of this edit` : "Review the first five seconds before exporting."}</p>
                          {previewBusy ? <button className="secondary-button" onClick={() => previewRequest.current?.abort()}><X size={14} />Cancel preview</button> : <button className="secondary-button" disabled={!engineReady || !liveInterval} onClick={() => void renderManualPreview()}><MonitorPlay size={14} />Render 5s preview</button>}
                        </div>
                        {manualPreviewError && <p className="manual-preview-error" role="alert">{manualPreviewError}</p>}
                      </>}
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
                          <b>02</b>{" "}
                          {mode === "auto" ? "Auto remix" : "Make it yours"}
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

              {mode === "auto" ? (
                <AutoPanel
                  options={autoOptions}
                  onChange={(options) => updateAuto({ options })}
                  sources={sources}
                  selectedId={selected?.id}
                  onSourceChange={setSelectedId}
                  onApplyAll={applyAutoAll}
                  libraryBusy={brollBusy}
                  capabilities={autoCapabilities}
                  variants={selectedAuto.variants}
                  onVariantsChange={(variants) => updateAuto({ variants })}
                  onBrollSelectionChange={(ids) =>
                    updateAuto({ options: { ...autoOptions, brollIds: ids } })
                  }
                  onBrollRemoved={removeBrollSelection}
                  onLibraryBusyChange={setBrollBusy}
                  maxFileSize={health?.maxFileSize}
                  maxFiles={health?.maxFiles}
                />
              ) : (
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
                          {adjustedCount} adjusted
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
                    {(["essentials", "color", "advanced", "all"] as const).map(
                      (value) => (
                        <button
                          key={value}
                          id={`tab-${value}`}
                          type="button"
                          role="tab"
                          aria-selected={tab === value}
                          aria-controls="settings-content"
                          className={tab === value ? "active" : ""}
                          onClick={() => { setTab(value); if (value === "all" || tab === "all") requestAnimationFrame(() => document.getElementById("settings-content")?.parentElement?.scrollIntoView({ block: "start" })); }}
                        >
                          {value === "essentials"
                            ? "Essentials"
                            : value === "color"
                              ? "Color & feel"
                              : value === "advanced" ? "Advanced" : "All controls"}
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
                    <OwnFootagePanel key={selected?.id || "default"} value={settings.ownFootage} onChange={ownFootage => updateSettings({ ownFootage })} disabled={starting} />
                    <FinishingPresets mode="manual" settings={settings} disabled={starting || attachmentBusy !== null} onApply={updateSettings} />
                    {selected && <ManualPromptEditor key={selected.id} sourceId={selected.id} settings={settings}
                      disabled={starting || attachmentBusy !== null} onApply={replaceSettings} />}
                    {(tab === "essentials" || tab === "all") && (
                      <>
                        <Section
                          title="Color looks"
                          icon={<WandSparkles size={13} />}
                        >
                          <div className="look-grid">
                            {MANUAL_LOOKS.map((look) => <button key={look.id} type="button" className={`look-button ${activeColorLook(settings) === look.id ? "active" : ""}`} aria-pressed={activeColorLook(settings) === look.id} title={look.description} onClick={() => replaceSettings(applyColorLook(settings, look.id))}>
                              <span className="look-swatch" style={{ background: look.swatch }} aria-hidden="true" /><span>{look.name}</span>
                            </button>)}
                          </div>
                          <p className="field-hint">Color looks keep your framing, timing and audio settings.</p>
                        </Section>
                        <Section
                          title="Frame it right"
                          icon={<Expand size={13} />}
                        >
                          <div className="aspect-options">
                            {(
                              [
                                "original",
                                "9:16",
                                "1:1",
                                "4:5",
                                "16:9",
                              ] as const
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
                              <option value="blur">Blur background</option>
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
                            defaultValue={DEFAULT_SETTINGS.zoom}
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
                          <Toggle label="Clean up video" value={settings.qualityCleanup ?? false} onChange={(qualityCleanup) => updateSettings({ qualityCleanup })} detail="Free cleanup on your computer: reduce noise and sharpen lightly." />
                          <Toggle label="Gentle push-in" value={settings.autoMotion ?? false} onChange={(autoMotion) => updateSettings({ autoMotion })} detail="Slow camera movement. With blur fit, the background moves." />
                          <details className="manual-subsection">
                            <summary>Subject position</summary>
                            <p className="field-hint">Choose what stays in frame when cropping or zooming into the original picture.</p>
                            <fieldset disabled={settings.fit !== "crop" && settings.zoom === 1}>
                              <legend className="visually-hidden">Crop position</legend>
                              <Slider label="Horizontal position" value={(settings.focalPoint?.x ?? 0.5) * 100} defaultValue={50} min={0} max={100} step={1} unit="%" onChange={(x) => updateSettings({ focalPoint: { x: x / 100, y: settings.focalPoint?.y ?? 0.5 } })} />
                              <Slider label="Vertical position" value={(settings.focalPoint?.y ?? 0.5) * 100} defaultValue={50} min={0} max={100} step={1} unit="%" onChange={(y) => updateSettings({ focalPoint: { x: settings.focalPoint?.x ?? 0.5, y: y / 100 } })} />
                            </fieldset>
                          </details>
                        </Section>
                        <Section
                          title="Pace & sound"
                          icon={<AudioLines size={14} />}
                        >
                          <Slider
                            label="Playback speed"
                            value={settings.speed}
                            defaultValue={DEFAULT_SETTINGS.speed}
                            min={0.5}
                            max={2}
                            unit="×"
                            onChange={(speed) => updateSettings({ speed })}
                          />
                          <Slider
                            label="Volume"
                            value={settings.volume}
                            defaultValue={DEFAULT_SETTINGS.volume}
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
                          <Toggle label="Normalize loudness" value={settings.normalizeAudio ?? false} onChange={(normalizeAudio) => updateSettings({ normalizeAudio })} detail="Keep speech at a more consistent listening level." />
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
                                onClick={() =>
                                  updateSettings({ audioId: null })
                                }
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
                    {(tab === "color" || tab === "all") && (
                      <>
                        <div className="tab-intro manual-color-intro">
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
                            defaultValue={DEFAULT_SETTINGS.brightness}
                            min={-1}
                            max={1}
                            onChange={(brightness) =>
                              updateSettings({ brightness })
                            }
                          />
                          <Slider
                            label="Contrast"
                            value={settings.contrast}
                            defaultValue={DEFAULT_SETTINGS.contrast}
                            min={0}
                            max={2}
                            unit="×"
                            onChange={(contrast) =>
                              updateSettings({ contrast })
                            }
                          />
                          <Slider
                            label="Saturation"
                            value={settings.saturation}
                            defaultValue={DEFAULT_SETTINGS.saturation}
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
                            defaultValue={DEFAULT_SETTINGS.temperature}
                            min={-1}
                            max={1}
                            onChange={(temperature) =>
                              updateSettings({ temperature })
                            }
                          />
                          <Slider
                            label="Hue shift"
                            value={settings.hue}
                            defaultValue={DEFAULT_SETTINGS.hue}
                            min={-180}
                            max={180}
                            step={1}
                            unit="°"
                            onChange={(hue) => updateSettings({ hue })}
                          />
                          <Slider
                            label="Gamma"
                            value={settings.gamma}
                            defaultValue={DEFAULT_SETTINGS.gamma}
                            min={0.1}
                            max={3}
                            onChange={(gamma) => updateSettings({ gamma })}
                          />
                        </Section>
                        <Section title="Texture">
                          <Slider
                            label="Sharpness"
                            value={settings.sharpness}
                            defaultValue={DEFAULT_SETTINGS.sharpness}
                            min={0}
                            max={2}
                            onChange={(sharpness) =>
                              updateSettings({ sharpness })
                            }
                          />
                          <Slider
                            label="Film grain"
                            value={settings.noise}
                            defaultValue={DEFAULT_SETTINGS.noise}
                            min={0}
                            max={1}
                            onChange={(noise) => updateSettings({ noise })}
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
                            })
                          }
                        >
                          <RotateCcw size={13} />
                          Reset color & texture
                        </button>
                      </>
                    )}
                    {(tab === "advanced" || tab === "all") && (
                      <>
                        <Section
                          title="Trim & motion"
                          icon={<Scissors size={13} />}
                        >
                          <div className="fields-row">
                            <label className="number-field">
                              Start (seconds)
                              <input
                                type="number"
                                disabled={!!settings.segments}
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
                                disabled={!!settings.segments}
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
                            {settings.segments ? "This edit uses a sequence of source cuts. Describe new timestamps in your prompt to change the sequence." : "Leave the end blank to keep the rest of the video."}
                          </p>
                          {selected && <p className={`manual-trim-summary ${liveInterval ? "" : "invalid"}`} role="status">{sequencePreview
                            ? `${sequencePreview.cuts.length} source cuts: ${sequencePreview.cuts.map(cut => `${cut.start.toFixed(1)}–${cut.end.toFixed(1)}s`).join(", then ")} · ${sequencePreview.outputDuration.toFixed(1)}s export`
                            : liveInterval ? `${liveInterval.start.toFixed(1)}–${liveInterval.end.toFixed(1)}s of source · ${liveInterval.outputDuration.toFixed(1)}s export`
                              : settings.segments ? "Each source cut must end after its start and stay within this video." : "Choose a trim with its end after its start, within this video."}</p>}
                          {settings.segments && <button type="button" className="secondary-button" onClick={() => updateSettings({
                            segments: undefined, trimStart: sequencePreview?.first.start ?? 0, trimEnd: sequencePreview?.first.end ?? null, timeShift: 0,
                          })}>Use first cut as a single trim</button>}
                          {!settings.segments && <Slider
                            label="Time shift"
                            value={settings.timeShift}
                            defaultValue={DEFAULT_SETTINGS.timeShift}
                            min={-5}
                            max={5}
                            step={0.1}
                            unit="s"
                            onChange={(timeShift) =>
                              updateSettings({ timeShift })
                            }
                            hint="Move the trimmed window earlier or later, keeping its length. Set a trim first."
                          />}
                          <Slider
                            label="Blend"
                            value={settings.blend}
                            defaultValue={DEFAULT_SETTINGS.blend}
                            min={0}
                            max={1}
                            onChange={(blend) => updateSettings({ blend })}
                            hint="Blend neighboring frames for a softer motion effect."
                          />
                          <Slider
                            label="Frame blend"
                            step={0.001}
                            value={settings.frameBlend}
                            defaultValue={DEFAULT_SETTINGS.frameBlend}
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
                            defaultValue={DEFAULT_SETTINGS.hookDuration}
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
                        <Section
                          title="Captions"
                          icon={<Subtitles size={14} />}
                        >
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
                          {settings.subtitleId && <details className="manual-subsection">
                            <summary>Caption size &amp; placement</summary>
                            <Slider label="Caption size" value={settings.captionStyle?.fontSize ?? 20} defaultValue={20} min={12} max={40} step={1} onChange={(fontSize) => updateSettings({ captionStyle: { fontSize, bottomPercent: settings.captionStyle?.bottomPercent ?? 100 / 12 } })} />
                            <Slider label="Caption bottom spacing" value={settings.captionStyle?.bottomPercent ?? 100 / 12} defaultValue={100 / 12} min={5} max={80} step={0.1} unit="%" onChange={(bottomPercent) => updateSettings({ captionStyle: { fontSize: settings.captionStyle?.fontSize ?? 20, bottomPercent } })} />
                          </details>}
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
              )}
              </>}
            </div>

            {mode !== "shorts" && <section
              className={`render-bar ${mode === "auto" ? "auto-render-bar" : ""}`}
            >
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
              {mode === "manual" && (
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
              )}
              {mode === "auto" && (
                <div className="auto-render-summary">
                  <span>
                    <Check size={12} />
                    {uniformAuto
                      ? AUTO_FORMAT_NAMES[autoOptions.aspect]
                      : "Individual video settings"}
                  </span>
                  <span>
                    {uniformAuto
                      ? `Up to ${autoOptions.targetDuration}s · `
                      : ""}
                    Up to {exportCount} exports total
                  </span>
                  {uniformAuto && <span>{visualSourceSummary(autoOptions)}{getVisualSources(autoOptions).length > 0 ? ` · ${autoOptions.brollCount ?? DEFAULT_BROLL_COUNT} supporting shots target` : ""}</span>}
                </div>
              )}
              <div className="render-cta">
                {mode === "auto" && <>
                  <label className="auto-render-scope">Render
                    <select aria-label="Auto videos to render" value={autoRenderScope} disabled={starting} onChange={(event) => setAutoRenderScope(event.target.value as "all" | "current" | "selected")}>
                      <option value="current">This video</option>
                      <option value="selected">Selected videos ({sources.filter((source) => autoSelectedIds.includes(source.id)).length})</option>
                      <option value="all">All videos ({sources.length})</option>
                    </select>
                  </label>
                  {autoRenderScope === "selected" && !autoTargets.length && <p className="auto-selection-hint">Check videos in the source list to include them.</p>}
                </>}
                {mode === "manual" && sources.length > 1 && (
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
                    (mode === "auto" && !autoTargets.length) ||
                    starting ||
                    !engineReady ||
                    attachmentBusy !== null ||
                    brollBusy ||
                    noBrollSelected
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
                      : mode === "auto"
                        ? `Auto remix ${autoTargets.length} video${autoTargets.length === 1 ? "" : "s"}`
                        : `Create ${exportCount || ""} ${exportCount === 1 ? "remix" : "remixes"}`}
                  </span>
                  <ArrowRight size={17} />
                </button>
                <span className="render-fineprint">
                  {noBrollSelected
                    ? `Choose uploaded B-roll for ${missingBrollSources.length} video${missingBrollSources.length === 1 ? "" : "s"}, or deselect My B-roll.`
                    : brollBusy
                      ? "Preparing your supporting clips…"
                      : "MP4 export · H.264 · Ready to share"}
                </span>
              </div>
            </section>}
        </div>
        {view === "history" ? (
          <HistoryPanel source={historySource} refreshKey={completed.map((job) => job.id).sort().join("|")} onClearSource={() => setHistorySource(null)} onBack={() => setView("studio")} />
        ) : view === "exports" ? (
          <section className="exports-panel panel">
            <div className="exports-heading">
              <div>
                <h2>
                  Your exports{" "}
                  <span className="count-pill">{completed.length}</span>
                </h2>
                <p>
                  {pending.length
                    ? `${pending.filter(job => job.status === "processing").length} processing · ${pending.filter(job => job.status === "queued").length} queued${health ? ` · Up to ${health.concurrency} at once` : ""}. You can keep working in the studio.`
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
                            {batch.some((job) => job.status === "skipped")
                              ? `${batchCompleted.length} exported · ${batch.filter((job) => job.status === "skipped").length} skipped`
                              : `${batch.length} cut${batch.length === 1 ? "" : "s"}`}
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
                          title="Clear export files; keep source videos and History"
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
                        const retryStatus = ["failed", "cancelled", "skipped"].includes(job.status);
                        const repeatedSkip = job.status === "skipped" && (!job.notes?.length ||
                          job.notes.some(note => /\brepeat\w*|\btoo similar\b|\balready has\b|\bgenerate anyway\b/i.test(note)));
                        const jobAspect =
                          !job.summary && job.auto
                            ? job.auto.aspect
                            : job.settings.aspect;
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
                                <strong
                                  title={job.summary?.title || job.sourceName}
                                >
                                  {job.summary?.title || job.sourceName}
                                </strong>
                                <span>V{job.variant}</span>
                                {job.parentJobId && <span>Revision {job.revision ?? 1}</span>}
                                {job.auto && (
                                  <span className="job-auto-tag">
                                    <Sparkles size={9} />
                                    Auto
                                  </span>
                                )}
                              </div>
                              {job.summary?.title && (
                                <p
                                  className="job-source-name"
                                  title={job.sourceName}
                                >
                                  {job.sourceName}
                                </p>
                              )}
                              <div className="job-details">
                                <span>
                                  {jobAspect === "original"
                                    ? "Original ratio"
                                    : jobAspect}
                                </span>
                                <span>·</span>
                                <span>
                                  {job.summary
                                    ? `${duration(job.summary.sourceDuration)} → ${duration(job.summary.outputDuration)}`
                                    : job.auto
                                      ? `Up to ${job.auto.targetDuration}s`
                                      : `${job.settings.speed.toFixed(2)}× speed`}
                                </span>
                                <span>·</span>
                                <span>
                                  {job.outputSize
                                    ? formatSize(job.outputSize)
                                    : "MP4"}
                                </span>
                              </div>
                              {["processing", "queued"].includes(job.status) && job.phase && (
                                <p className="job-phase">
                                  {job.status === "processing" ? <LoaderCircle size={11} className="spin" /> : <Clock3 size={11} />}
                                  {job.phase}
                                </p>
                              )}
                              {job.status === "processing" && (
                                <div className="job-progress">
                                  <span
                                    style={{
                                      width: `${Math.max(1, Math.min(100, job.progress))}%`,
                                    }}
                                  />
                                </div>
                              )}
                              {job.summary && (
                                <div className="job-summary">
                                  {job.summary.changes.map((change, index) => (
                                    <span key={index}>{change}</span>
                                  ))}
                                  {job.summary.narration &&
                                    !job.summary.changes.some(
                                      (change) =>
                                        change.toLowerCase() ===
                                        "new narration",
                                    ) && <span>New narration</span>}
                                </div>
                              )}
                              <QualityReportSummary report={job.qualityReport} compact />
                              <EditorialReportSummary report={job.editorialReport} repair={job.editorialRepair} compact
                                onRetry={job.status === "completed" && job.auto && job.editable ? () => void retryEditorialReview(job) : undefined}
                                retrying={editorialRetries[job.id]?.pending} retryError={editorialRetries[job.id]?.error} />
                              {job.supportingVisuals?.some(
                                (visual) => visual.attribution,
                              ) && (
                                <ul
                                  className="job-notes stock-credits"
                                  aria-label="Stock video credits"
                                >
                                  {job.supportingVisuals
                                    .filter((visual) => visual.attribution)
                                    .map((visual, index) => (
                                      <li key={index}>
                                        {visual.start.toFixed(1)}–
                                        {visual.end.toFixed(1)}s: Video by{" "}
                                        {visual.attribution!.creator} on{" "}
                                        <a
                                          href={visual.attribution!.url}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          {visual.attribution!.provider}
                                        </a>
                                      </li>
                                    ))}
                                </ul>
                              )}
                              {job.visualFulfillment && <p className="job-notes" role="status"><strong>Supporting visuals: {job.visualFulfillment.placed}/{job.visualFulfillment.requested}</strong>{job.visualFulfillment.placed < job.visualFulfillment.requested && <> · {job.visualFulfillment.reason || "Some requested visuals could not be added."}</>}</p>}
                              {!!job.notes?.length && (
                                <ul className="job-notes">
                                  {compactBrollNotes(job.notes).map((note, index) => (
                                    <li key={index}>{note}</li>
                                  ))}
                                </ul>
                              )}
                              {job.status === "skipped" &&
                                !job.notes?.length && (
                                  <p className="job-skip-note">
                                    This cut was too similar to another version,
                                    so no extra file was exported.
                                  </p>
                                )}
                              {retryStatus && !source && <p id={`retry-source-${job.id}`} className="job-skip-note">
                                The source video is no longer available. Import it again to start a new edit.
                              </p>}
                              <JobRecoveryNotice job={job} />
                              {job.error && !job.retry && (
                                <p className="job-error">{job.error}</p>
                              )}
                            </div>
                            <div className={`job-status ${job.qualityReport?.status === "review" || (job.editorialReport && job.editorialReport.status !== "pass") ? "quality-review" : ""}`}>
                              {job.status === "completed" ? (
                                <>
                                  <Check size={12} />
                                  {job.qualityReport?.status === "review" || (job.editorialReport && job.editorialReport.status !== "pass") ? "Review" : "Rendered"}
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
                                  {job.auto && job.editable && <button className="secondary-button job-edit-button" onClick={() => setEditingJob(job)}>
                                    <Scissors size={13} />Edit this result
                                  </button>}
                                  {job.captionUrl && (
                                    <a
                                      className="caption-download"
                                      href={job.captionUrl}
                                      download
                                      title="Download SRT captions"
                                      aria-label={`Download captions for ${job.sourceName}`}
                                    >
                                      <Subtitles size={15} />
                                    </a>
                                  )}
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
                              ) : retryStatus ? (
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={!source}
                                  aria-describedby={!source ? `retry-source-${job.id}` : undefined}
                                  onClick={() => void jobAction(job, "retry")}
                                >
                                  <RefreshCw size={13} />
                                  {repeatedSkip ? "Generate anyway" : "Retry"}
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
        ) : null}

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
      {editingJob && <EditPlanEditor job={editingJob} onClose={() => setEditingJob(null)} onCreated={(created) => {
        setJobs((current) => [created, ...current.filter((job) => job.id !== created.id)]);
        setEditingJob(null);
        setView("exports");
        notify("Your corrected revision is queued. The previous export is still available.", "success");
      }} />}
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
                <h2 title={previewJob.summary?.title || previewJob.sourceName}>
                  {previewJob.summary?.title || previewJob.sourceName}
                </h2>
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
            <QualityReportSummary report={previewJob.qualityReport} />
            <EditorialReportSummary report={previewJob.editorialReport} repair={previewJob.editorialRepair}
              onRetry={previewJob.status === "completed" && previewJob.auto && previewJob.editable ? () => void retryEditorialReview(previewJob) : undefined}
              retrying={editorialRetries[previewJob.id]?.pending} retryError={editorialRetries[previewJob.id]?.error} />
            {previewJob.summary && (
              <div className="export-auto-summary">
                <h3>What changed</h3>
                <p>{previewJob.summary.changes.join(" · ")}</p>
                <p>
                  {duration(previewJob.summary.sourceDuration)} source →{" "}
                  {duration(previewJob.summary.outputDuration)} finished cut
                  {previewJob.summary.narration ? " · New narration" : ""}
                </p>
                {!!previewJob.notes?.length && (
                  <ul className="job-notes">
                    {previewJob.notes.map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="export-preview-footer">
              <span>Final render, with all edits applied.</span>
              {previewJob.auto && previewJob.editable && <button className="secondary-button" onClick={() => {
                const job = previewJob;
                setPreviewJob(null);
                // Let the preview restore focus and page scrolling before the
                // editor establishes its own dialog focus and scroll boundary.
                window.setTimeout(() => setEditingJob(job), 0);
              }}><Scissors size={14} />Edit this result</button>}
              {previewJob.captionUrl && (
                <a
                  className="secondary-button"
                  href={previewJob.captionUrl}
                  download
                >
                  <Subtitles size={14} />
                  SRT captions
                </a>
              )}
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
                    Drop several videos into the workspace at once. Auto remix
                    is selected for you, with a vertical format for TikTok and
                    Reels.
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>Press Auto remix</h3>
                  <p>
                    The studio analyzes each video, picks an excerpt, tightens
                    the pacing and prepares a new edit. When speech is
                    available, it adds a written hook and captions. Original
                    audio is kept unless you choose new narration in the
                    optional preferences.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>Review and download</h3>
                  <p>
                    Follow the actual editing steps in Exports. Preview the
                    finished videos, read what changed, and download individual
                    MP4s or the whole collection as a ZIP.
                  </p>
                </div>
              </li>
            </ol>
            <div className="guide-note">
              <h3>A couple of good things to know</h3>
              <p>
                B-roll is optional and off by default. Choose Stock B-roll to
                find existing videos on Pixabay or Pexels, or upload your own library. A
                few short cutaways match the spoken content while your main
                audio continues. Animated text cards are a separate option.
              </p>
              <p>
                Want full control? Switch to Manual for your own trim, framing,
                color, audio, captions and saved presets. Manual settings are
                separate from automatic edits.
              </p>
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
