import { useEffect, useRef, useState } from "react";
import { api, type CropPreview, type ModelStatus } from "./api.ts";
import { type DeckEntry, frontArt, type PrintSettings } from "./core/index.ts";
import { ErrorNotice, StatusRegion } from "./ui.tsx";
import "./upscale-comparison.css";

function modelLabel(model: ModelStatus) {
  switch (model.tier) {
    case "default":
      return "General x4v3";
    case "fast":
      return "Anime v3";
    case "quality":
      return "Quality x4plus";
    default:
      return model.name;
  }
}

function imageSrc(bytes: number[]) {
  return `data:image/png;base64,${btoa(bytes.map((byte) => String.fromCharCode(byte)).join(""))}`;
}

export function UpscaleComparison({
  entries,
  models,
  settings,
  activeModel,
  onChoose,
}: {
  entries: DeckEntry[];
  models: ModelStatus[];
  settings: PrintSettings;
  activeModel: string | null | undefined;
  onChoose: (model: string | null) => void;
}) {
  const active = useRef<{ key: string; controller: AbortController } | null>(
    null,
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [cancelledKey, setCancelledKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: unknown }>();
  const [entryId, setEntryId] = useState("");
  const [result, setResult] = useState<{
    key: string;
    previews: CropPreview[];
  }>();
  const selected = entries.find((entry) => entry.id === entryId) ?? entries[0];
  const art = selected ? frontArt(selected) : null;
  const sourceKey = JSON.stringify([
    selected?.id,
    art,
    settings.cardWidthMm,
    settings.cardHeightMm,
    settings.bleedColor,
    models.filter((model) => model.installed).map((model) => model.id),
  ]);
  const previews = result?.key === sourceKey ? result.previews : null;
  const busy = busyKey === sourceKey;
  const cancelled = cancelledKey === sourceKey;
  const methods = [
    { id: null, label: "Lanczos", installed: true },
    ...models.map((model) => ({
      id: model.id,
      label: modelLabel(model),
      installed: model.installed,
    })),
  ];
  useEffect(() => {
    return () => {
      const request = active.current;
      if (request?.key === sourceKey) request.controller.abort();
    };
  }, [sourceKey]);
  const cancel = () => {
    active.current?.controller.abort();
    active.current = null;
    setBusyKey(null);
  };
  const compare = async () => {
    if (!art) return;
    setCancelledKey(null);
    active.current?.controller.abort();
    const controller = new AbortController();
    const request = { key: sourceKey, controller };
    active.current = request;
    setBusyKey(sourceKey);
    setFailure(undefined);
    try {
      const previews = await api.compareUpscalers(
        art,
        settings,
        controller.signal,
      );
      if (!controller.signal.aborted) setResult({ key: sourceKey, previews });
    } catch (error) {
      if (!controller.signal.aborted) setFailure({ key: sourceKey, error });
    } finally {
      if (active.current === request) {
        active.current = null;
        setBusyKey(null);
      }
    }
  };

  return (
    <details className="panel upscale-comparison">
      <summary>Compare upscale models</summary>
      {!art ? (
        <p className="hint">Include a card in this print to compare models.</p>
      ) : (
        <>
          <div className="toolbar upscale-comparison-controls">
            <label className="field">
              Comparison card
              <select
                value={selected?.id}
                onChange={(event) => {
                  cancel();
                  setCancelledKey(null);
                  setEntryId(event.target.value);
                }}
              >
                {entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.card.name} · {frontArt(entry).set.toUpperCase()}{" "}
                    {frontArt(entry).collectorNumber}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => void compare()}>
              {busy ? "Restart render" : "Render text crops"}
            </button>
            {busy && (
              <button
                type="button"
                onClick={() => {
                  cancel();
                  setCancelledKey(sourceKey);
                }}
              >
                Cancel render
              </button>
            )}
          </div>
          <p className="hint">
            1:1 crops at native 4× output. Times exclude model loading. Results
            sample the lower part of the scan, not the final print DPI.
          </p>
          <StatusRegion
            label="Upscale comparison status"
            className={busy || cancelled ? "hint" : "sr-only"}
          >
            {busy
              ? "Rendering installed models on this device…"
              : cancelled
                ? "Comparison cancelled"
                : null}
          </StatusRegion>
          <ErrorNotice
            error={failure?.key === sourceKey ? failure.error : null}
            retry={() => void compare()}
          />
          <div className="upscale-crops">
            {methods.map(({ id, label, installed }) => {
              const preview = previews?.find(
                (preview) => preview.modelId === id,
              );
              const crop = preview && "crop" in preview ? preview.crop : null;
              return (
                <article className="upscale-crop" key={id ?? "lanczos"}>
                  <div className="upscale-crop-label">
                    <strong>{label}</strong>
                    {crop && (
                      <span className="mono muted">
                        {crop.elapsedMs < 1000
                          ? `${crop.elapsedMs.toFixed(1)} ms`
                          : `${(crop.elapsedMs / 1000).toFixed(2)} s`}
                      </span>
                    )}
                  </div>
                  <div className="upscale-crop-image">
                    {crop ? (
                      <img
                        src={imageSrc(crop.png)}
                        width={crop.width}
                        height={crop.height}
                        alt={`${label} text crop`}
                      />
                    ) : !installed ? (
                      <a href="#/settings/models">Download in Settings</a>
                    ) : (
                      <span className="hint">
                        {preview && "error" in preview
                          ? preview.error
                          : "No crop yet"}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-pressed={activeModel === id}
                    disabled={!installed}
                    onClick={() => onChoose(id)}
                  >
                    Use {label}
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}
    </details>
  );
}
