import { apiRequest } from "./api-client";
import ProblemNotice from "./ProblemNotice";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Play, Undo2 } from "lucide-react";
import type { ShortDraft } from "../shared/shorts";
import { formatSourceClock, parseSourceClock } from "../shared/shorts";
import {
  applyPacing,
  NATURAL_PACING,
  pacingCutSignature,
  pacingOptionsSchema,
  type PacingOptions as PacingChoices,
  type PacingSuggestion,
} from "../shared/pacing";
import PacingOptions from "./PacingOptions";
import "./pacing.css";
export default function ShortPacing({
  draft,
  defaultOptions,
  active,
  disabled,
  onChange,
  onPreview,
}: {
  draft: ShortDraft;
  defaultOptions?: PacingChoices;
  active: boolean;
  disabled?: boolean;
  onChange: (patch: Partial<ShortDraft>) => void;
  onPreview: (start: number, end: number) => void;
}) {
  const [options, setOptions] = useState(
    draft.pacingReview?.options || defaultOptions || NATURAL_PACING,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const signature = pacingCutSignature(draft.cuts),
    review = draft.pacingReview;
  const current =
    !!review &&
    (review.appliedSignature || pacingCutSignature(review.baseCuts)) ===
      signature;
  const matching =
    current && JSON.stringify(review?.options) === JSON.stringify(options);
  const selected =
    review?.removals.filter((item) => !review.skippedIds.includes(item.id)) ||
    [];
  useEffect(() => {
    if (!active) {
      request.current?.abort();
      setBusy(false);
    }
    return () => request.current?.abort();
  }, [active]);
  useEffect(() => {
    request.current?.abort();
    setBusy(false);
    setError("");
  }, [signature]);
  const analyze = async () => {
    if (!pacingOptionsSchema.safeParse(options).success) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    const base = current ? review!.baseCuts : draft.cuts;
    try {
      const result = await apiRequest<PacingSuggestion>("/api/shorts/pacing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sourceId: draft.sourceId,
          options,
          cuts: base.map((cut) => ({
            start: parseSourceClock(cut.start),
            end: parseSourceClock(cut.end),
          })),
        }),
      });
      if (!controller.signal.aborted)
        onChange({
          pacingReview: {
            baseCuts: base.map(({ id, start, end, focalPoint }) => ({
              id,
              start,
              end,
              ...(focalPoint ? { focalPoint } : {}),
            })),
            options,
            removals: (result as PacingSuggestion).removals,
            notes: result.notes,
            skippedIds: [],
            ...(current && review?.appliedSignature
              ? { appliedSignature: review.appliedSignature }
              : {}),
          },
        });
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error ? error.message : "Pacing analysis failed.",
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  const apply = () => {
    if (!review || !matching) return;
    const cuts = review.baseCuts.flatMap((cut, index) =>
      applyPacing(
        [
          {
            start: parseSourceClock(cut.start)!,
            end: parseSourceClock(cut.end)!,
            focalPoint: cut.focalPoint,
          },
        ],
        review.removals
          .filter((item) => item.cutIndex === index)
          .map((item) => ({ ...item, cutIndex: 0 })),
        review.skippedIds,
      ).map((segment, part) => ({
        id: part === 0 ? cut.id : crypto.randomUUID(),
        start: formatSourceClock(segment.start),
        end: formatSourceClock(segment.end),
        ...(segment.focalPoint ? { focalPoint: segment.focalPoint } : {}),
      })),
    );
    onChange({
      cuts,
      focusAnalysis: undefined,
      pacingReview: { ...review, appliedSignature: pacingCutSignature(cuts) },
    });
  };
  return (
    <details className="short-pacing">
      <summary>
        Refine the pacing<span>Free · local</span>
      </summary>
      <div className="short-pacing-body">
        <p>
          Review pauses before cutting. Speech recognition can miss words;
          listen to each proposed trim.
        </p>
        <PacingOptions
          value={options}
          onChange={setOptions}
          disabled={busy || disabled}
        />
        <button
          className="secondary-button"
          disabled={
            busy || disabled || !pacingOptionsSchema.safeParse(options).success
          }
          onClick={() => void analyze()}
        >
          {busy ? <LoaderCircle className="spin" size={14} /> : null}
          {busy ? "Analyzing speech locally…" : "Review suggested trims"}
        </button>
        {busy && (
          <button
            className="text-button"
            onClick={() => {
              request.current?.abort();
              setBusy(false);
            }}
          >
            Cancel analysis
          </button>
        )}
        {error && (
          <ProblemNotice message={error} operation="Adjust pacing" />
        )}
        {review && (
          <>
            {!current && (
              <p>
                The sequences changed. Review them again to prepare new trims.
              </p>
            )}
            {current && (
              <>
                <strong>
                  {review.removals.length} proposed trims ·{" "}
                  {selected
                    .reduce((sum, item) => sum + item.end - item.start, 0)
                    .toFixed(1)}
                  s selected
                </strong>
                {review.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
                {!review.removals.length && (
                  <p>
                    No suitable pauses or isolated fillers were found. Your
                    timing stays intact.
                  </p>
                )}
                <div className="pacing-removals">
                  {review.removals.map((item) => (
                    <div key={item.id} className="pacing-removal">
                      <label>
                        <input
                          type="checkbox"
                          checked={!review.skippedIds.includes(item.id)}
                          disabled={!matching || busy || disabled}
                          onChange={(event) =>
                            onChange({
                              pacingReview: {
                                ...review,
                                skippedIds: event.target.checked
                                  ? review.skippedIds.filter(
                                      (id) => id !== item.id,
                                    )
                                  : [...review.skippedIds, item.id],
                              },
                            })
                          }
                        />
                        <span>
                          {item.label}
                          <small>
                            {formatSourceClock(item.start)} ·{" "}
                            {(item.end - item.start).toFixed(2)}s
                          </small>
                        </span>
                      </label>
                      <button
                        className="icon-button"
                        aria-label={`Listen around ${item.label}`}
                        onClick={() =>
                          onPreview(
                            Math.max(
                              parseSourceClock(
                                review.baseCuts[item.cutIndex].start,
                              )!,
                              item.start - 1,
                            ),
                            Math.min(
                              parseSourceClock(
                                review.baseCuts[item.cutIndex].end,
                              )!,
                              item.end + 1,
                            ),
                          )
                        }
                      >
                        <Play size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="pacing-actions">
                  <button
                    className="secondary-button"
                    disabled={!matching || busy || disabled}
                    onClick={apply}
                  >
                    Apply selected trims
                  </button>
                  {review.appliedSignature && (
                    <button
                      className="text-button"
                      disabled={busy || disabled}
                      onClick={() =>
                        onChange({
                          cuts: review.baseCuts,
                          focusAnalysis: undefined,
                          pacingReview: {
                            ...review,
                            appliedSignature: undefined,
                          },
                        })
                      }
                    >
                      <Undo2 size={14} />
                      Undo pacing changes
                    </button>
                  )}
                </div>
                {!matching && (
                  <p>
                    Settings changed. Review suggestions again before applying.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </details>
  );
}
