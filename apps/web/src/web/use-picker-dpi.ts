import { useCallback, useEffect, useRef, useState } from "react";
import type { Art, PrintSettings } from "../core/index.ts";
import { readPickerDpi } from "./source-dpi.ts";

type Request = { key: string; art: Art; settings: PrintSettings };
const concurrentReads = 3;
const queuedReads = new Set<() => Promise<void>>();
let activeReads = 0;

function startReads() {
  for (const read of queuedReads) {
    if (activeReads >= concurrentReads) break;
    queuedReads.delete(read);
    activeReads++;
    void read().finally(() => {
      activeReads--;
      startReads();
    });
  }
}

function enqueueRead(read: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const run = () => read(controller.signal);
  queuedReads.add(run);
  startReads();
  return () => {
    queuedReads.delete(run);
    controller.abort();
  };
}

function createQueue(
  onReading: (key: string, dpi: number | undefined) => void,
) {
  const pending = new Map<string, () => void>();
  const attempted = new Set<string>();
  const measured = new Set<string>();

  return (requests: Request[]) => {
    const eligible = new Set(requests.map(({ key }) => key));
    for (const key of attempted) {
      if (eligible.has(key)) continue;
      attempted.delete(key);
      pending.get(key)?.();
      pending.delete(key);
    }
    for (const { key, art, settings } of requests) {
      if (attempted.has(key) || measured.has(key)) continue;
      attempted.add(key);
      const cancel = enqueueRead(async (signal) => {
        try {
          const dpi = await readPickerDpi(art, settings, signal);
          if (signal.aborted) return;
          if (dpi !== undefined) measured.add(key);
          onReading(key, dpi);
        } catch {
          if (!signal.aborted) onReading(key, undefined);
        } finally {
          if (!signal.aborted) pending.delete(key);
        }
      });
      pending.set(key, cancel);
    }
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
  const [readings, setReadings] = useState(
    new Map<string, number | undefined>(),
  );
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
    hasFinished: (art: Art) => readings.has(sourceKey(art, settings)),
  };
}
