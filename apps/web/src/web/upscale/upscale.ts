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

export async function upscaleImage(
  image: RgbImage,
  spec: ModelSpec,
  { assetBase, signal, onProgress }: Options,
): Promise<UpscaleResult> {
  const model = await loadModel(spec, assetBase, signal, (done, total) =>
    onProgress?.({ kind: "download", done, total }),
  );
  signal.throwIfAborted();

  const worker = new Worker(new URL("./upscale-worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    return await new Promise<UpscaleResult>((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      const cleanup = () => signal.removeEventListener("abort", cancel);
      signal.addEventListener("abort", cancel, { once: true });
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (data.kind === "tile") {
          onProgress?.(data);
        } else {
          cleanup();
          if (data.kind === "result") resolve(data.result);
          else reject(new Error(data.message));
        }
      };
      worker.onerror = ({ message }) => {
        cleanup();
        reject(new Error(message || "The upscaling worker could not start"));
      };
      const request: WorkerRequest = {
        image,
        model,
        assetBase: assetBase.href,
      };
      try {
        worker.postMessage(request, [model]);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  } finally {
    worker.terminate();
  }
}
