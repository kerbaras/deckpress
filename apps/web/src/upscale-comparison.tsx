import { type PointerEvent, useEffect, useId, useRef, useState } from "react";
import {
  api,
  type CropPosition,
  type CropPreview,
  comparisonThumbnailSrc,
  type ModelStatus,
} from "./api.ts";
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

const defaultPosition = { x: 0.5, y: 0.78 };
const step = 0.05;
const arrowSteps = {
  ArrowLeft: { x: -step, y: 0 },
  ArrowRight: { x: step, y: 0 },
  ArrowUp: { x: 0, y: -step },
  ArrowDown: { x: 0, y: step },
};

const clampPosition = (value: number) => Math.max(0, Math.min(value, 1));

function pointerPosition(event: PointerEvent<HTMLButtonElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: clampPosition((event.clientX - rect.left) / rect.width),
    y: clampPosition((event.clientY - rect.top) / rect.height),
  };
}

function CropPicker({
  src,
  position,
  onMove,
}: {
  src: string | undefined;
  position: CropPosition;
  onMove: (position: CropPosition) => void;
}) {
  const instructions = useId();
  const pointerId = useRef<number | null>(null);
  const [draft, setDraft] = useState<CropPosition | null>(null);
  const marker = draft ?? position;
  const clearDrag = () => {
    pointerId.current = null;
    setDraft(null);
  };
  return (
    <div className="upscale-crop-picker">
      <button
        type="button"
        aria-label="Crop position"
        aria-describedby={instructions}
        onKeyDown={(event) => {
          const delta = arrowSteps[event.key as keyof typeof arrowSteps];
          if (!delta) return;
          event.preventDefault();
          const next = {
            x: clampPosition(position.x + delta.x),
            y: clampPosition(position.y + delta.y),
          };
          if (next.x !== position.x || next.y !== position.y) onMove(next);
        }}
        onClick={(event) => {
          if (event.detail === 0) onMove(position);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || pointerId.current !== null) return;
          const next = pointerPosition(event);
          if (!next) return;
          pointerId.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDraft(next);
        }}
        onPointerMove={(event) => {
          if (event.pointerId === pointerId.current)
            setDraft(pointerPosition(event));
        }}
        onPointerUp={(event) => {
          if (event.pointerId !== pointerId.current) return;
          const next = pointerPosition(event);
          clearDrag();
          if (next) onMove(next);
        }}
        onLostPointerCapture={(event) => {
          if (event.pointerId === pointerId.current) clearDrag();
        }}
      >
        {src && <img src={src} alt="" draggable={false} />}
        <span
          className="upscale-crop-target"
          aria-hidden="true"
          style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
        />
      </button>
      <p className="hint" id={instructions}>
        Drag on the card or use the arrow keys to move the crop.{" "}
        {Math.round(position.x * 100)}% across, {Math.round(position.y * 100)}%
        down.
      </p>
    </div>
  );
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
  const [picked, setPicked] = useState<{
    key: string;
    position: CropPosition;
  }>();
  const [result, setResult] = useState<{
    key: string;
    previews: CropPreview[];
  }>();
  const selected = entries.find((entry) => entry.id === entryId) ?? entries[0];
  const art = selected ? frontArt(selected) : null;
  const artKey = JSON.stringify([selected?.id, art]);
  const position = picked?.key === artKey ? picked.position : defaultPosition;
  const sourceKey = JSON.stringify([
    selected?.id,
    art,
    settings.cardWidthMm,
    settings.cardHeightMm,
    settings.bleedColor,
    models.filter((model) => model.installed).map((model) => model.id),
  ]);
  const keyAt = (position: CropPosition) =>
    JSON.stringify([sourceKey, position]);
  const comparisonKey = keyAt(position);
  const isDefault =
    position.x === defaultPosition.x && position.y === defaultPosition.y;
  const previews = result?.key === comparisonKey ? result.previews : null;
  const busy = busyKey === comparisonKey;
  const cancelled = cancelledKey === comparisonKey;
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
  const compare = async (position: CropPosition) => {
    if (!art) return;
    setCancelledKey(null);
    active.current?.controller.abort();
    const controller = new AbortController();
    const request = { key: sourceKey, controller };
    active.current = request;
    const key = keyAt(position);
    setBusyKey(key);
    setFailure(undefined);
    try {
      const previews = await api.compareUpscalers(
        art,
        settings,
        controller.signal,
        position,
      );
      if (!controller.signal.aborted) setResult({ key, previews });
    } catch (error) {
      if (!controller.signal.aborted) setFailure({ key, error });
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
                  setPicked(undefined);
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
            <button type="button" onClick={() => void compare(position)}>
              {busy
                ? "Restart render"
                : isDefault
                  ? "Render text crops"
                  : "Render crops"}
            </button>
            {busy && (
              <button
                type="button"
                onClick={() => {
                  cancel();
                  setCancelledKey(comparisonKey);
                }}
              >
                Cancel render
              </button>
            )}
          </div>
          <CropPicker
            key={artKey}
            src={comparisonThumbnailSrc(art, settings)}
            position={position}
            onMove={(position) => {
              setPicked({ key: artKey, position });
              void compare(position);
            }}
          />
          <p className="hint">
            1:1 crops at native 4× output, not the final print DPI. Times
            exclude model loading.
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
            error={failure?.key === comparisonKey ? failure.error : null}
            retry={() => void compare(position)}
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
                        alt={`${label} ${isDefault ? "text crop" : "crop"}`}
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
