import { loadModel } from "./model-store.ts";
import type { ModelSpec } from "./models.ts";
import type { RgbImage } from "./tiling.ts";
import type {
  Timing,
  UpscaleResult,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.ts";

export { upscaleModels } from "./models.ts";
export type { RgbImage } from "./tiling.ts";

export type UpscaleProgress =
  | { kind: "download"; done: number; total: number }
  | { kind: "tile"; done: number; total: number; timing: Timing };

type Options = {
  assetBase: URL;
  signal: AbortSignal;
  onProgress?: (progress: UpscaleProgress) => void;
};

export const UPSCALE_INIT_TIMEOUT_MS = 30_000;

export class UpscaleInitTimeout extends Error {
  override name = "UpscaleInitTimeout";
  constructor(stage: "download" | "worker") {
    const component =
      stage === "download" ? "Upscaling model" : "Upscaling worker";
    super(
      `${component} initialization timed out. Retry, or reload the page if it keeps failing.`,
    );
  }
}

export async function upscaleImage(
  image: RgbImage,
  spec: ModelSpec,
  { assetBase, signal, onProgress }: Options,
): Promise<UpscaleResult> {
  signal.throwIfAborted();
  const download = new AbortController();
  const forwardAbort = () => download.abort(signal.reason);
  signal.addEventListener("abort", forwardAbort, { once: true });
  let downloadTimer: ReturnType<typeof setTimeout> | undefined;
  const resetDownloadTimer = () => {
    clearTimeout(downloadTimer);
    downloadTimer = setTimeout(() => {
      console.debug("[deckpress:upscale] download stall timeout");
      download.abort(new UpscaleInitTimeout("download"));
    }, UPSCALE_INIT_TIMEOUT_MS);
  };
  let model: ArrayBuffer;
  try {
    resetDownloadTimer();
    model = await loadModel(spec, assetBase, download.signal, (done, total) => {
      resetDownloadTimer();
      onProgress?.({ kind: "download", done, total });
    });
  } catch (error) {
    if (!signal.aborted && download.signal.reason instanceof UpscaleInitTimeout)
      throw download.signal.reason;
    throw error;
  } finally {
    clearTimeout(downloadTimer);
    signal.removeEventListener("abort", forwardAbort);
  }
  signal.throwIfAborted();

  const worker = new Worker(new URL("./upscale-worker.ts", import.meta.url), {
    type: "module",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<UpscaleResult>((resolve, reject) => {
      let initializing = true;
      const resetInitTimer = () => {
        clearTimeout(timer);
        if (!initializing) return;
        timer = setTimeout(() => {
          console.debug("[deckpress:upscale] worker init timeout");
          reject(new UpscaleInitTimeout("worker"));
        }, UPSCALE_INIT_TIMEOUT_MS);
      };
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      resetInitTimer();
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (data.kind === "init") {
          initializing = !data.ready;
          resetInitTimer();
        } else if (data.kind === "tile") {
          initializing = false;
          resetInitTimer();
          onProgress?.(data);
        } else if (data.kind === "result") {
          resolve(data.result);
        } else {
          reject(new Error(data.message));
        }
      };
      worker.onerror = ({ message }) => {
        reject(new Error(message || "The upscaling worker could not start"));
      };
      worker.onmessageerror = () => {
        reject(new Error("Could not read the upscaling worker response"));
      };
      const request: WorkerRequest = {
        image,
        model,
        assetBase: assetBase.href,
      };
      try {
        worker.postMessage(request, [model]);
      } catch (error) {
        reject(error);
      }
    });
  } finally {
    clearTimeout(timer);
    if (cancel) signal.removeEventListener("abort", cancel);
    worker.terminate();
  }
}
