import { useCallback, useEffect, useRef, useState } from "react";
import type { Art, PrintSettings } from "../core/index.ts";
import { readPickerDpi } from "./source-dpi.ts";

type Request = { key: string; art: Art; settings: PrintSettings };
const concurrentReads = 3;

function createQueue(onReading: (key: string, dpi: number) => void) {
  const running = new Set<string>();
  const attempted = new Set<string>();
  const measured = new Set<string>();
  let eligible = new Map<string, Request>();

  function pump() {
    for (const { key, art, settings } of eligible.values()) {
      if (running.size >= concurrentReads) break;
      if (running.has(key) || attempted.has(key) || measured.has(key)) continue;
      running.add(key);
      attempted.add(key);
      void readPickerDpi(art, settings)
        .then(
          (dpi) => {
            if (dpi === undefined) return;
            measured.add(key);
            onReading(key, dpi);
          },
          () => {},
        )
        .finally(() => {
          running.delete(key);
          pump();
        });
    }
  }

  return (requests: Request[]) => {
    eligible = new Map(requests.map((request) => [request.key, request]));
    for (const key of attempted) {
      if (!eligible.has(key)) attempted.delete(key);
    }
    pump();
  };
}

function sourceKey(art: Art, settings: PrintSettings) {
  return JSON.stringify([
    art.imageUrl,
    art.provider,
    art.bleedMm,
    settings.cardWidthMm,
    settings.cardHeightMm,
    settings.bleedMm,
    settings.dpi,
  ]);
}

export function usePickerDpi(
  enabled: boolean,
  selected: Art | null,
  arts: Art[],
  settings: PrintSettings,
) {
  const tiles = useRef(new Set<HTMLButtonElement>());
  const observer = useRef<IntersectionObserver | null>(null);
  const [visible, setVisible] = useState(new Set<Element>());
  const [readings, setReadings] = useState(new Map<string, number>());
  const [reconcile] = useState(() =>
    createQueue((key, dpi) => {
      setReadings((previous) => new Map(previous).set(key, dpi));
    }),
  );

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const next = new IntersectionObserver((entries) => {
      setVisible((previous) => {
        const items = new Set(previous);
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target.isConnected)
            items.add(entry.target);
          else items.delete(entry.target);
        }
        return items;
      });
    });
    observer.current = next;
    for (const tile of tiles.current) next.observe(tile);
    return () => {
      next.disconnect();
      observer.current = null;
    };
  }, [enabled]);

  const observeTile = useCallback((tile: HTMLButtonElement | null) => {
    if (!tile) return;
    tiles.current.add(tile);
    observer.current?.observe(tile);
    return () => {
      observer.current?.unobserve(tile);
      tiles.current.delete(tile);
      setVisible((previous) => {
        if (!previous.has(tile)) return previous;
        const items = new Set(previous);
        items.delete(tile);
        return items;
      });
    };
  }, []);

  useEffect(() => () => reconcile([]), [reconcile]);
  useEffect(() => {
    const ids = new Set(
      Array.from(visible, (tile) => tile.getAttribute("data-source-art")),
    );
    const eligible = enabled
      ? [
          ...(selected ? [selected] : []),
          ...arts.filter((art) => ids.has(art.id)),
        ]
      : [];
    reconcile(
      eligible
        .filter((art) => art.provider !== "mpc")
        .map((art) => ({ key: sourceKey(art, settings), art, settings })),
    );
  }, [arts, enabled, reconcile, selected, settings, visible]);

  return {
    observeTile,
    dpi: (art: Art) => readings.get(sourceKey(art, settings)),
  };
}
