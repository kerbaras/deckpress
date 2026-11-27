import type { Art, PrintSettings } from "../core/index.ts";
import { webAssetBase } from "./asset-base.ts";
import { loadCoreWasm } from "./core-wasm.ts";
import { imageSrc } from "./store/image-cache.ts";
import { readUploadImage } from "./store/upload-files.ts";

async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal) {
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function sourceDimensions(art: Art, signal: AbortSignal) {
  const blob = await (art.provider === "upload"
    ? untilAborted(readUploadImage(art.imageUrl), signal)
    : sourceImage(art.imageUrl, signal));
  signal.throwIfAborted();
  const src = URL.createObjectURL(blob);
  const image = new Image();
  const abort = () => {
    image.src = "data:,";
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    image.src = src;
    await image.decode();
    signal.throwIfAborted();
    return [image.naturalWidth, image.naturalHeight] as const;
  } finally {
    signal.removeEventListener("abort", abort);
    URL.revokeObjectURL(src);
  }
}

async function sourceImage(url: string, signal: AbortSignal) {
  const src = imageSrc(url);
  if (!src) throw new Error("Unrecognized source image");
  const cache = await untilAborted(
    caches.open("deckpress-web-art-v1").catch(() => undefined),
    signal,
  );
  const cached = await untilAborted(
    cache?.match(src).catch(() => undefined) ?? Promise.resolve(undefined),
    signal,
  );
  signal.throwIfAborted();
  if (cached) return untilAborted(cached.blob(), signal);
  const response = await fetch(src, { signal });
  if (!response.ok)
    throw new Error(`Scryfall image returned ${response.status}`);
  const cacheCopy =
    cache && response.status !== 206 ? response.clone() : undefined;
  const blob = await response.blob();
  if (cacheCopy && cache)
    await untilAborted(
      cache.put(src, cacheCopy).catch(() => {}),
      signal,
    );
  return blob;
}

export async function readPickerDpi(
  art: Art,
  settings: PrintSettings,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const [width, height] = await sourceDimensions(art, signal);
  signal.throwIfAborted();
  const wasm = await untilAborted(loadCoreWasm(webAssetBase()), signal);
  signal.throwIfAborted();
  const { effectiveDpi } = JSON.parse(
    wasm.assessSource(
      width,
      height,
      JSON.stringify(art),
      JSON.stringify(settings),
    ),
  );
  return typeof effectiveDpi === "number" ? effectiveDpi : undefined;
}
