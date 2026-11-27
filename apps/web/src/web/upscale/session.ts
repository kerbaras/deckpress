import {
  type Backend,
  type BrowserCapabilities,
  backendCandidates,
  openBackend,
} from "./backend-selection.ts";
import { ESRGAN, type RgbImage, upscaleTiles } from "./tiling.ts";
import type { Timing } from "./worker-protocol.ts";

export async function openUpscaler(model: ArrayBuffer, assetBase: URL) {
  const { gpu } = navigator as typeof navigator &
    Pick<BrowserCapabilities, "gpu">;
  const candidates = await backendCandidates({
    gpu,
    crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });
  async function open({ provider, threads }: Backend) {
    console.debug("[deckpress:upscale] loading ONNX runtime", {
      provider,
      threads,
    });
    const ortUrl = new URL("ort/ort.webgpu.min.mjs", assetBase);
    // Each fallback can initialize ORT with its own provider and thread count.
    if (candidates.length > 1)
      ortUrl.searchParams.set("backend", `${provider}-${threads}`);
    const {
      env,
      InferenceSession,
      Tensor,
    }: typeof import("onnxruntime-web/webgpu") = await import(
      /* @vite-ignore */ ortUrl.href
    );
    const wasm = "ort/ort-wasm-simd-threaded.asyncify";
    env.wasm.wasmPaths = {
      mjs: new URL(`${wasm}.mjs`, assetBase),
      wasm: new URL(`${wasm}.wasm`, assetBase),
    };
    env.wasm.numThreads = threads;
    console.debug(
      "[deckpress:upscale] creating session (WASM, threads, model)",
      { provider, threads },
    );
    const session = await InferenceSession.create(model, {
      executionProviders: [provider],
    });
    const [inputName] = session.inputNames;
    const [outputName] = session.outputNames;
    if (!inputName || !outputName) {
      await session.release();
      throw new Error("Model input or output is missing");
    }
    console.debug("[deckpress:upscale] session ready", { provider, threads });
    return { session, Tensor, inputName, outputName };
  }
  let active:
    | { backend: Backend; session: Awaited<ReturnType<typeof open>> }
    | undefined = await openBackend(candidates, open);
  return {
    release: () => active?.session.session.release(),
    async run(
      image: RgbImage,
      signal: AbortSignal,
      onProgress: (done: number, total: number, timing: Timing) => void,
      onFallback?: (ready: boolean) => void,
    ) {
      while (true) {
        signal.throwIfAborted();
        if (!active) throw new Error("The upscaler is unavailable");
        try {
          return await runTiles(active, image, signal, onProgress);
        } catch (error) {
          const fallback = candidates.slice(
            candidates.indexOf(active.backend) + 1,
          );
          if (signal.aborted || fallback.length === 0) throw error;
          onFallback?.(false);
          await active.session.session.release().catch(() => {});
          active = undefined;
          active = await openBackend(fallback, open);
          onFallback?.(true);
        }
      }
    },
  };
}

async function runTiles(
  active: {
    backend: Backend;
    session: {
      session: import("onnxruntime-web").InferenceSession;
      Tensor: typeof import("onnxruntime-web").Tensor;
      inputName: string;
      outputName: string;
    };
  },
  image: RgbImage,
  signal: AbortSignal,
  onProgress: (done: number, total: number, timing: Timing) => void,
) {
  const {
    backend,
    session: { session, Tensor, inputName, outputName },
  } = active;
  let elapsed = 0;
  let tiles = 0;
  const timing = (): Timing => ({
    ...backend,
    msPerTile: tiles ? elapsed / tiles : 0,
  });
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
    signal,
    (done, total) => onProgress(done, total, timing()),
  );
  return { image: upscaled, timing: timing() };
}
