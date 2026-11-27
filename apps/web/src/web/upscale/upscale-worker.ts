import {
  type BrowserCapabilities,
  backendCandidates,
  openBackend,
} from "./backend-selection.ts";
import { ESRGAN, upscaleTiles } from "./tiling.ts";
import type {
  Timing,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.ts";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

async function upscale({ image, model, assetBase }: WorkerRequest) {
  const ortUrl = new URL("ort/ort.webgpu.min.mjs", assetBase).href;
  const {
    env,
    InferenceSession,
    Tensor,
  }: typeof import("onnxruntime-web/webgpu") = await import(
    /* @vite-ignore */ ortUrl
  );
  const { gpu } = navigator as typeof navigator &
    Pick<BrowserCapabilities, "gpu">;
  const candidates = await backendCandidates({
    gpu,
    crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });
  const wasm = "ort/ort-wasm-simd-threaded.asyncify";
  env.wasm.wasmPaths = {
    mjs: new URL(`${wasm}.mjs`, assetBase),
    wasm: new URL(`${wasm}.wasm`, assetBase),
  };
  env.wasm.numThreads = candidates.at(-1)?.threads ?? 1;
  const { backend, session } = await openBackend(candidates, ({ provider }) =>
    InferenceSession.create(model, { executionProviders: [provider] }),
  );
  const [inputName] = session.inputNames;
  const [outputName] = session.outputNames;
  let elapsed = 0;
  let tiles = 0;
  const timing = (): Timing => ({
    provider: backend.provider,
    threads: env.wasm.numThreads ?? 1,
    msPerTile: tiles ? elapsed / tiles : 0,
  });
  try {
    if (!inputName || !outputName)
      throw new Error("Model input or output is missing");
    const upscaled = await upscaleTiles(
      image,
      async (input) => {
        const tensor = new Tensor("float32", input, [
          1,
          3,
          ESRGAN.tile,
          ESRGAN.tile,
        ]);
        try {
          const start = performance.now();
          const outputs = await session.run({ [inputName]: tensor });
          const output = outputs[outputName];
          const data = output?.data;
          output?.dispose();
          if (!(data instanceof Float32Array))
            throw new Error("Expected a float32 model output");
          elapsed += performance.now() - start;
          tiles++;
          return data;
        } finally {
          tensor.dispose();
        }
      },
      new AbortController().signal,
      (done, total) =>
        scope.postMessage({ kind: "tile", done, total, timing: timing() }),
    );
    return { image: upscaled, timing: timing() };
  } finally {
    await session.release();
  }
}

scope.onmessage = async ({ data }) => {
  try {
    const result = await upscale(data);
    scope.postMessage({ kind: "result", result }, [result.image.pixels.buffer]);
  } catch (error) {
    scope.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
