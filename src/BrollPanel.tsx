import { apiRequest as request, recordResponseProblems } from "./api-client";
import ProblemNotice from "./ProblemNotice";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  Film,
  LoaderCircle,
  RefreshCw,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import type { BrollAsset } from "../shared/types";
import { DEFAULT_IMPORT_BATCH_SIZE } from "../shared/imports";


const sizeLabel = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export default function BrollPanel({
  selectedIds,
  onSelectionChange,
  onBusyChange,
  onRemoved,
  aiMatching = false,
  maxFiles = DEFAULT_IMPORT_BATCH_SIZE,
  maxFileSize = 500 * 1024 ** 2,
}: {
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onBusyChange: (busy: boolean) => void;
  onRemoved: (id: string) => void;
  aiMatching?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
}) {
  const [assets, setAssets] = useState<BrollAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const selectedRef = useRef(selectedIds);
  const changeRef = useRef(onSelectionChange);
  const requestRef = useRef<XMLHttpRequest | null>(null);
  selectedRef.current = selectedIds;
  changeRef.current = onSelectionChange;

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await request<{ assets: BrollAsset[] }>("/api/broll");
      if (!mountedRef.current) return;
      setAssets(data.assets);
      const retained = selectedRef.current.filter((id) =>
        data.assets.some((asset) => asset.id === id),
      );
      if (retained.length !== selectedRef.current.length)
        changeRef.current(retained);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(progress !== null || busyId !== null);
  }, [progress, busyId, onBusyChange]);
  useEffect(
    () => () => {
      requestRef.current?.abort();
      onBusyChange(false);
    },
    [onBusyChange],
  );

  const upload = (files: File[]) => {
    if (!files.length || progress !== null) return;
    if (files.length > maxFiles) {
      setError(`Add up to ${maxFiles} clips at once.`);
      return;
    }
    const tooLarge = files.find((file) => file.size > maxFileSize);
    if (tooLarge) {
      setError(
        `${tooLarge.name} is over the ${sizeLabel(maxFileSize)} file limit.`,
      );
      return;
    }
    const nonVideo = files.find(
      (file) =>
        !file.type.startsWith("video/") &&
        !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name),
    );
    if (nonVideo) {
      setError(
        `${nonVideo.name} is not a supported video. Add video clips to your B-roll library.`,
      );
      return;
    }
    const data = new FormData();
    files.forEach((file) => data.append("videos", file));
    setProgress(0);
    setError("");
    setNotice("");
    const xhr = new XMLHttpRequest();
    requestRef.current = xhr;
    xhr.open("POST", "/api/broll");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        setProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => {
      setProgress(null);
      setError("Upload interrupted. Please try again.");
    };
    xhr.onabort = () => {
      setProgress(null);
      setNotice(
        "Upload cancelled. Refresh the library if any clips had already finished.",
      );
    };
    xhr.onload = () => {
      setProgress(null);
      try {
        const data = JSON.parse(xhr.responseText) as {
          assets?: BrollAsset[];
          errors?: { name: string; error: string }[];
          error?: string;
        };
        recordResponseProblems(data, xhr.status, "/api/broll", "POST", xhr.getResponseHeader("X-Request-ID"));
        if (xhr.status < 200 || xhr.status >= 300) {
          setError(data.error || "Upload failed. Please try again.");
          return;
        }
        if (!mountedRef.current) return;
        const added = data.assets || [];
        setAssets((current) => [
          ...added,
          ...current.filter(
            (asset) => !added.some((item) => item.id === asset.id),
          ),
        ]);
        changeRef.current([
          ...new Set([
            ...selectedRef.current,
            ...added.map((asset) => asset.id),
          ]),
        ]);
        if (added.length)
          setNotice(
            `${added.length} clip${added.length === 1 ? "" : "s"} added and selected.`,
          );
        if (data.errors?.length)
          setError(
            data.errors.map((item) => `${item.name}: ${item.error}`).join(" "),
          );
      } catch {
        setError(
          "The server returned an unexpected upload response. Please refresh the library.",
        );
      }
    };
    xhr.send(data);
  };

  const updateTags = async (asset: BrollAsset, tags: string[]) => {
    setBusyId(asset.id);
    setError("");
    try {
      const result = await request<BrollAsset>(`/api/broll/${asset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      setAssets((current) =>
        current.map((item) => (item.id === asset.id ? result : item)),
      );
      setNotice(`Tags saved for ${asset.name}.`);
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (asset: BrollAsset) => {
    setBusyId(asset.id);
    setError("");
    try {
      await request(`/api/broll/${asset.id}`, { method: "DELETE" });
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      onRemoved(asset.id);
      setNotice(`${asset.name} removed from the library.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="broll-library" aria-label="Your B-roll library">
      <div className="broll-heading">
        <h3>
          <Film size={14} />
          Your B-roll videos
        </h3>
        <button
          type="button"
          title="Refresh B-roll library"
          aria-label="Refresh B-roll library"
          disabled={loading || progress !== null}
          onClick={() => void load()}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>
      <p className="broll-description">
        Upload footage you own or have licensed. Select the clips this video can
        use.
      </p>
      <input
        ref={uploadInput}
        className="visually-hidden"
        type="file"
        multiple
        accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi"
        aria-label="Upload B-roll videos"
        onChange={(event) => {
          upload(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className={`broll-upload ${dragging ? "dragging" : ""}`}
        disabled={progress !== null}
        onClick={() => uploadInput.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          upload(Array.from(event.dataTransfer.files));
        }}
      >
        {progress !== null ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Upload size={16} />
        )}
        <span>
          {progress === null
            ? "Add B-roll videos"
            : progress < 100
              ? `Uploading… ${progress}%`
              : "Preparing clips…"}
        </span>
        <small>
          {progress === null
            ? `${sizeLabel(maxFileSize)} per clip · videos only`
            : "Keep this section open"}
        </small>
      </button>
      {progress !== null && (
        <div className="broll-progress">
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      {progress !== null && (
        <button
          type="button"
          className="broll-cancel"
          onClick={() => requestRef.current?.abort()}
        >
          Cancel upload
        </button>
      )}
      {error && (
        <ProblemNotice message={error} operation="Manage B-roll" />
      )}
      {notice && (
        <p className="broll-notice" role="status">
          {notice}
        </p>
      )}
      {assets.length > 0 && (
        <div className="broll-selection-heading">
          <span>
            {
              selectedIds.filter((id) =>
                assets.some((asset) => asset.id === id),
              ).length
            }{" "}
            selected
          </span>
          <button
            type="button"
            onClick={() =>
              onSelectionChange(
                selectedIds.length === assets.length
                  ? []
                  : assets.map((asset) => asset.id),
              )
            }
          >
            {selectedIds.length === assets.length
              ? "Deselect all"
              : "Use all clips"}
          </button>
        </div>
      )}
      <div className="broll-assets">
        {assets.map((asset) => (
          <BrollCard
            key={asset.id}
            asset={asset}
            selected={selectedIds.includes(asset.id)}
            disabled={busyId !== null || progress !== null}
            onSelect={() =>
              onSelectionChange(
                selectedIds.includes(asset.id)
                  ? selectedIds.filter((id) => id !== asset.id)
                  : [...selectedIds, asset.id],
              )
            }
            onSaveTags={(tags) => updateTags(asset, tags)}
            onRemove={() => void remove(asset)}
          />
        ))}
      </div>
      {!loading && !assets.length && !error && (
        <p className="broll-empty">Your selected clips will appear here.</p>
      )}
      {assets.length > 0 && !selectedIds.length && (
        <p className="broll-empty">
          Select at least one clip to include B-roll in this video.
        </p>
      )}
      {!!selectedIds.length && (
        <p className="broll-footnote">
          {aiMatching
            ? "AI can skip clips that do not support the speech. Tags are optional."
            : "Only relevant clips are used. Add descriptive tags once, such as “coffee, kitchen, pouring”."}
        </p>
      )}
    </section>
  );
}

function BrollCard({
  asset,
  selected,
  disabled,
  onSelect,
  onSaveTags,
  onRemove,
}: {
  asset: BrollAsset;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onSaveTags: (tags: string[]) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(asset.tags.join(", "));
  const [editing, setEditing] = useState(false);
  const tags = [
    ...new Set(
      draft
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
  const invalidTags = tags.length > 12 || tags.some((tag) => tag.length > 60);
  const changed = tags.join(", ") !== asset.tags.join(", ");
  useEffect(() => {
    setDraft(asset.tags.join(", "));
  }, [asset.tags]);
  return (
    <article className={`broll-asset ${selected ? "selected" : ""}`}>
      <div className="broll-asset-row">
        <label>
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled}
            onChange={onSelect}
          />
          <img src={asset.thumbnailUrl} alt="" />
          <span>
            <strong>{asset.name}</strong>
            <small>
              {Math.round(asset.duration)}s · {asset.width} × {asset.height}
            </small>
          </span>
        </label>
        <button
          type="button"
          className="broll-remove"
          disabled={disabled}
          aria-label={`Remove B-roll ${asset.name}`}
          title="Remove clip from library"
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="broll-tag-row">
        <span>{asset.tags.length ? asset.tags.join(", ") : "No tags yet"}</span>
        <button
          type="button"
          onClick={() => setEditing((value) => !value)}
          aria-expanded={editing}
        >
          <Tag size={12} />
          {editing ? "Close" : "Tags"}
        </button>
      </div>
      {editing && (
        <form
          className="broll-tag-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalidTags)
              void onSaveTags(tags).then((saved) => {
                if (saved) setEditing(false);
              });
          }}
        >
          <label>
            Tags for this clip
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={700}
              placeholder="coffee, kitchen, pouring"
              aria-label={`Tags for ${asset.name}`}
              aria-invalid={invalidTags}
            />
          </label>
          {invalidTags && (
            <p className="broll-error">
              Use up to 12 tags, with at most 60 characters each.
            </p>
          )}
          <button type="submit" disabled={!changed || disabled || invalidTags}>
            <Check size={13} />
            Save tags
          </button>
        </form>
      )}
    </article>
  );
}
