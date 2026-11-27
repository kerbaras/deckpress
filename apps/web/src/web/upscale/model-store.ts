import type { ModelSpec } from "./models.ts";

export type DownloadProgress = (downloaded: number, total: number) => void;

const MODEL_CACHE = "deckpress-upscale-models-v1";
type ModelCache = Pick<Cache, "match" | "put" | "delete">;

class IntegrityError extends Error {
  override name = "IntegrityError";
}

async function matchesDigest(bytes: ArrayBuffer, spec: ModelSpec) {
  if (bytes.byteLength !== spec.bytes) return false;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return hex === spec.sha256;
}

async function readDownload(
  response: Response,
  bytes: number,
  signal: AbortSignal,
  progress?: DownloadProgress,
): Promise<ArrayBuffer> {
  if (!response.ok || !response.body)
    throw new Error(`Model download failed (${response.status})`);
  const reader = response.body.getReader();
  const data = new Uint8Array(bytes);
  let offset = 0;
  try {
    progress?.(0, bytes);
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes)
        throw new IntegrityError("Model size does not match");
      data.set(value, offset);
      offset += value.length;
      progress?.(offset, bytes);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (offset !== bytes) throw new IntegrityError("Model size does not match");
  return data.buffer;
}

export async function readModel(
  spec: ModelSpec,
  url: URL,
  cache: ModelCache,
  signal: AbortSignal,
  progress?: DownloadProgress,
  download: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const key = url.href;
  const cached = await cache.match(key);
  if (cached) {
    const bytes = await cached.arrayBuffer();
    const matches = await matchesDigest(bytes, spec);
    signal.throwIfAborted();
    if (matches) return bytes;
    await cache.delete(key);
  }

  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await download(key, {
      signal,
      cache: "no-store",
      mode: "same-origin",
    });
    let bytes: ArrayBuffer;
    try {
      bytes = await readDownload(response, spec.bytes, signal, progress);
      if (!(await matchesDigest(bytes, spec)))
        throw new IntegrityError("Model SHA-256 does not match");
    } catch (error) {
      if (attempt === 0 && error instanceof IntegrityError) continue;
      throw error;
    }
    signal.throwIfAborted();
    await cache.put(key, new Response(bytes));
    signal.throwIfAborted();
    return bytes;
  }
}

export async function loadModel(
  spec: ModelSpec,
  base: URL,
  signal: AbortSignal,
  progress?: DownloadProgress,
) {
  const url = new URL(`models/${spec.file}`, base);
  if (url.origin !== location.origin)
    throw new Error("Models must be served from this origin");
  void navigator.storage?.persist?.().catch(() => {});
  return readModel(spec, url, await caches.open(MODEL_CACHE), signal, progress);
}
