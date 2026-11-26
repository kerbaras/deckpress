import { useState } from "react";
import { api, type CropPreview, type ModelStatus } from "./api.ts";
import { type DeckEntry, frontArt, type PrintSettings } from "./core/index.ts";
import { ErrorNotice, useTask } from "./ui.tsx";
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
  const task = useTask();
  const [entryId, setEntryId] = useState("");
  const [result, setResult] = useState<{
    key: string;
    previews: CropPreview[];
  }>();
  const [requestedKey, setRequestedKey] = useState("");
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
  const methods = [
    { id: null, label: "Lanczos", installed: true },
    ...models.map((model) => ({
      id: model.id,
      label: modelLabel(model),
      installed: model.installed,
    })),
  ];
  const compare = () => {
    if (!art) return;
    setRequestedKey(sourceKey);
    void task.run(async () => {
      const previews = await api.compareUpscalers(art, settings);
      setResult({ key: sourceKey, previews });
    });
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
                disabled={task.busy}
                onChange={(event) => setEntryId(event.target.value)}
              >
                {entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.card.name} · {frontArt(entry).set.toUpperCase()}{" "}
                    {frontArt(entry).collectorNumber}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={task.busy} onClick={compare}>
              {task.busy ? "Rendering crops…" : "Render text crops"}
            </button>
          </div>
          <p className="hint">
            1:1 crops at native 4× output. Times exclude model loading. Results
            sample the lower part of the scan, not the final print DPI.
          </p>
          {task.busy && (
            <p role="status" className="hint">
              Rendering installed models on this device…
            </p>
          )}
          <ErrorNotice
            error={requestedKey === sourceKey ? task.error : null}
            retry={compare}
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
                    ) : (
                      <span className="hint">
                        {preview && "error" in preview
                          ? preview.error
                          : installed
                            ? "No crop yet"
                            : "Download in Settings"}
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
