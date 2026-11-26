import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ModelStatus } from "./api.ts";
import { ScanQualityBadge } from "./art-quality.tsx";
import type { Art, PrintSettings } from "./core/index.ts";
import { ErrorNotice, StatusRegion } from "./ui.tsx";

export function SourcePreflight({
  arts,
  settings,
  model,
}: {
  arts: Art[];
  settings: PrintSettings;
  model: ModelStatus | undefined;
}) {
  const [checked, setChecked] = useState(false);
  const dpi = useQuery({
    queryKey: [
      "source-dpi",
      settings.cardWidthMm,
      settings.cardHeightMm,
      settings.dpi,
      arts.map((art) => [art.imageUrl, art.provider, art.bleedMm]),
    ],
    queryFn: () => api.sourceDpi(arts, settings),
    enabled: checked && arts.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (!arts.length) return null;
  const readings = dpi.data;
  const low = readings?.filter(
    (reading) => reading !== null && reading.effectiveDpi < 300,
  ).length;
  const unavailable = readings?.filter((value) => value === null).length;
  return (
    <>
      {!checked && (
        <button type="button" onClick={() => setChecked(true)}>
          Check source DPI
        </button>
      )}
      <StatusRegion className="hint">
        {dpi.isFetching
          ? "Checking scan dimensions at the chosen trim…"
          : readings
            ? `${low} unique images below 300 effective DPI.${unavailable ? ` ${unavailable} could not be checked.` : ""}`
            : "Check actual source resolution before upscaling."}
      </StatusRegion>
      <ErrorNotice error={dpi.error} retry={() => void dpi.refetch()} />
      {readings && (
        <details open={!!low || !!unavailable}>
          <summary>Source quality by image</summary>
          <ul>
            {arts.map((art, index) => {
              const reading = readings[index];
              const value = reading?.effectiveDpi;
              const ai = !settings.upscale
                ? "off"
                : !model
                  ? "model unavailable"
                  : !model.installed
                    ? `blocked — download ${model.name}`
                    : !reading
                      ? `unknown — could not check source dimensions (${model.name})`
                      : reading.belowUpscaleThreshold
                        ? `will apply — ${model.name}`
                        : `not needed at ${settings.dpi} DPI (${model.name})`;
              return (
                <li key={art.id}>
                  {art.name} · {art.source} {art.collectorNumber}{" "}
                  <ScanQualityBadge art={art} />{" "}
                  {value == null
                    ? "DPI unavailable"
                    : `${Math.floor(value)} effective DPI${value < 300 ? " — below 300" : ""}`}
                  {" · "}AI upscaling: {ai}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </>
  );
}
