import {
  pacingOptionsSchema,
  NATURAL_PACING,
  type PacingOptions as Options,
} from "../shared/pacing";
export default function PacingOptions({
  value = NATURAL_PACING,
  onChange,
  disabled,
}: {
  value?: Options;
  onChange: (value: Options) => void;
  disabled?: boolean;
}) {
  return (
    <div className="pacing-options">
      <label>
        Pacing
        <select
          aria-label="Pacing"
          value={value.mode}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, mode: event.target.value as Options["mode"] })
          }
        >
          <option value="off">Original · keep pauses</option>
          <option value="natural">Natural · preserve breathing room</option>
          <option value="tight">Tight · shorter pauses</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {value.mode === "custom" && (
        <div className="pacing-numbers">
          <label>
            Trim pauses longer than (s)
            <input
              type="number"
              min={0.4}
              max={5}
              step={0.05}
              value={
                Number.isFinite(value.minimumPause) ? value.minimumPause : ""
              }
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, minimumPause: event.target.valueAsNumber })
              }
            />
          </label>
          <label>
            Leave this much pause (s)
            <input
              type="number"
              min={0.12}
              max={1}
              step={0.01}
              value={Number.isFinite(value.keepPause) ? value.keepPause : ""}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, keepPause: event.target.valueAsNumber })
              }
            />
          </label>
        </div>
      )}
      {!pacingOptionsSchema.safeParse(value).success && (
        <p className="shorts-error" role="alert">
          Use a pause threshold from 0.4–5 seconds, and leave 0.12–1 second,
          less than the threshold.
        </p>
      )}
      {value.mode !== "off" && (
        <label className="pacing-fillers">
          <input
            type="checkbox"
            checked={value.removeFillers}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, removeFillers: event.target.checked })
            }
          />
          <span>
            Remove isolated “um” / “uh” sounds
            <small>
              Only clear, separately timed fillers. Keep meaningful words and
              repetitions.
            </small>
          </span>
        </label>
      )}
    </div>
  );
}
