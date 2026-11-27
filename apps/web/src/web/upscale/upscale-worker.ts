import { openUpscaler } from "./session.ts";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.ts";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data: { image, model, assetBase } }) => {
  try {
    const upscaler = await openUpscaler(model, new URL(assetBase));
    try {
      const result = await upscaler.run(
        image,
        new AbortController().signal,
        (done, total, timing) =>
          scope.postMessage({ kind: "tile", done, total, timing }),
      );
      scope.postMessage({ kind: "result", result }, [
        result.image.pixels.buffer,
      ]);
    } finally {
      await upscaler.release();
    }
  } catch (error) {
    scope.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
