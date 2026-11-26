import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.ts";
import { ScanQualityBadge } from "./art-quality.tsx";
import type { Art, PrintSettings } from "./core/index.ts";
import { ErrorNotice, StatusRegion } from "./ui.tsx";

export function SourcePreflight({
  arts,
  settings,
}: {
  arts: Art[];
  settings: PrintSettings;
}) {
  const [checked, setChecked] = useState(false);
  const dpi = useQuery({
    queryKey: [
      "source-dpi",
      settings.cardWidthMm,
      settings.cardHeightMm,
      arts.map((art) => [art.imageUrl, art.provider, art.bleedMm]),
    ],
    queryFn: () => api.sourceDpi(arts, settings),
    enabled: checked && arts.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (!arts.length) return null;
  const readings = dpi.data;
  const low = readings?.filter((value) => value !== null && value < 300).length;
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
              const value = readings[index];
              return (
                <li key={art.id}>
                  {art.name} · {art.source} {art.collectorNumber}{" "}
                  <ScanQualityBadge art={art} />{" "}
                  {value == null
                    ? "DPI unavailable"
                    : `${Math.floor(value)} effective DPI${value < 300 ? " — below 300" : ""}`}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </>
  );
}
