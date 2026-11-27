import { afterEach, expect, it, vi } from "vitest";
import { loadModel } from "./model-store.ts";
import { upscaleModels } from "./models.ts";
import {
  UPSCALE_INIT_TIMEOUT_MS,
  UpscaleInitTimeout,
  upscaleImage,
} from "./upscale.ts";
import type { WorkerResponse } from "./worker-protocol.ts";

vi.mock("./model-store.ts", () => ({
  loadModel: vi.fn(),
}));

const mockedLoadModel = vi.mocked(loadModel);
const spec = upscaleModels[0];
if (!spec) throw new Error("Expected at least one upscale model");

const assetBase = new URL("https://example.test/deckpress/");
const image = { width: 2, height: 2, pixels: new Uint8Array(12) };
const sampleResult = {
  image: { width: 8, height: 8, pixels: new Uint8Array(192) },
  timing: { provider: "wasm" as const, threads: 4, msPerTile: 12 },
};

type FakeWorker = {
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function stubWorkers(queue: FakeWorker[]) {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        const next = queue.shift();
        if (!next) throw new Error("Unexpected Worker construction");
        // biome-ignore lint/correctness/noConstructorReturn: mock constructor returns test double
        return next;
      }
    },
  );
}

function makeWorker(): FakeWorker {
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
}

afterEach(() => {
  mockedLoadModel.mockReset();
  vi.useRealTimers();
});

it("times out a silent worker after 30 s, terminates it, and succeeds on Retry", async () => {
  vi.useFakeTimers();
  const stalled = makeWorker();
  const retry = makeWorker();
  stubWorkers([stalled, retry]);
  mockedLoadModel.mockResolvedValue(new ArrayBuffer(8));

  const first = upscaleImage(image, spec, {
    assetBase,
    signal: new AbortController().signal,
  });
  const expectTimeout = expect(first).rejects.toThrow(UpscaleInitTimeout);

  await vi.advanceTimersByTimeAsync(UPSCALE_INIT_TIMEOUT_MS - 1);
  expect(stalled.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expectTimeout;
  expect(stalled.terminate).toHaveBeenCalledOnce();

  const second = upscaleImage(image, spec, {
    assetBase,
    signal: new AbortController().signal,
  });
  await vi.advanceTimersByTimeAsync(0);
  retry.onmessage?.({ data: { kind: "init", ready: false } });
  retry.onmessage?.({ data: { kind: "init", ready: true } });
  // Once initialized, slow inference past 30 s must not time out.
  await vi.advanceTimersByTimeAsync(UPSCALE_INIT_TIMEOUT_MS + 5_000);
  expect(retry.terminate).not.toHaveBeenCalled();
  retry.onmessage?.({ data: { kind: "result", result: sampleResult } });
  await expect(second).resolves.toEqual(sampleResult);
  expect(retry.terminate).toHaveBeenCalledOnce();
});

it("keeps a slow progressing model download alive past 30 s", async () => {
  vi.useFakeTimers();
  const worker = makeWorker();
  stubWorkers([worker]);
  const onProgress = vi.fn();

  mockedLoadModel.mockImplementation(
    (_spec, _base, signal, progress) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        let step = 0;
        const interval = setInterval(() => {
          step++;
          progress?.(step * 1024, 3 * 1024);
          if (step === 3) {
            clearInterval(interval);
            resolve(new ArrayBuffer(8));
          }
        }, 20_000);
      }),
  );

  const pending = upscaleImage(image, spec, {
    assetBase,
    signal: new AbortController().signal,
    onProgress,
  });

  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(20_000);
  }
  expect(onProgress).toHaveBeenCalledTimes(3);
  expect(worker.postMessage).toHaveBeenCalledOnce();

  worker.onmessage?.({ data: { kind: "init", ready: true } });
  worker.onmessage?.({ data: { kind: "result", result: sampleResult } });
  await expect(pending).resolves.toEqual(sampleResult);
});

it("times out a stalled model download 30 s after the last progress and recovers on Retry", async () => {
  vi.useFakeTimers();
  const worker = makeWorker();
  stubWorkers([worker]);

  let aborted = false;
  mockedLoadModel.mockImplementationOnce(
    (_spec, _base, signal, progress) =>
      new Promise<ArrayBuffer>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
        setTimeout(() => progress?.(512, 4096), 20_000);
      }),
  );

  const first = upscaleImage(image, spec, {
    assetBase,
    signal: new AbortController().signal,
  });
  const expectTimeout = expect(first).rejects.toThrow(
    "Upscaling model initialization timed out",
  );

  await vi.advanceTimersByTimeAsync(20_000);
  await vi.advanceTimersByTimeAsync(UPSCALE_INIT_TIMEOUT_MS - 1);
  expect(aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expectTimeout;
  expect(aborted).toBe(true);

  mockedLoadModel.mockResolvedValueOnce(new ArrayBuffer(8));
  const retry = upscaleImage(image, spec, {
    assetBase,
    signal: new AbortController().signal,
  });
  await vi.advanceTimersByTimeAsync(0);
  worker.onmessage?.({ data: { kind: "init", ready: true } });
  worker.onmessage?.({ data: { kind: "result", result: sampleResult } });
  await expect(retry).resolves.toEqual(sampleResult);
});

it("re-arms the stall timer when the worker falls back to another backend", async () => {
  vi.useFakeTimers();
  const worker = makeWorker();
  stubWorkers([worker]);
  mockedLoadModel.mockResolvedValue(new ArrayBuffer(8));

  const pending = upscaleImage(image, spec, {
    assetBase,
    signal: new AbortController().signal,
  });
  const expectTimeout = expect(pending).rejects.toThrow(
    "Upscaling worker initialization timed out",
  );

  await vi.advanceTimersByTimeAsync(0);
  worker.onmessage?.({ data: { kind: "init", ready: true } });
  await vi.advanceTimersByTimeAsync(UPSCALE_INIT_TIMEOUT_MS + 10_000);
  expect(worker.terminate).not.toHaveBeenCalled();

  worker.onmessage?.({ data: { kind: "init", ready: false } });
  await vi.advanceTimersByTimeAsync(UPSCALE_INIT_TIMEOUT_MS);
  await expectTimeout;
  expect(worker.terminate).toHaveBeenCalledOnce();
});
