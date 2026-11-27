import { expect, it, vi } from "vitest";
import { backendCandidates, openBackend } from "./backend-selection.ts";

const isolated = { crossOriginIsolated: true, hardwareConcurrency: 8 };
const fp16Adapter = { features: new Set(["shader-f16"]) };

it("prefers WebGPU if the browser returns an adapter that supports FP16", async () => {
  const gpu = { requestAdapter: async () => fp16Adapter };
  expect(await backendCandidates({ ...isolated, gpu })).toEqual([
    { provider: "webgpu", threads: 8 },
    { provider: "wasm", threads: 8 },
    { provider: "wasm", threads: 1 },
  ]);
});

it("uses threaded WASM if WebGPU is missing, unusable, or denied", async () => {
  const wasm = [
    { provider: "wasm", threads: 8 },
    { provider: "wasm", threads: 1 },
  ];
  expect(await backendCandidates(isolated)).toEqual(wasm);
  expect(
    await backendCandidates({
      ...isolated,
      gpu: { requestAdapter: async () => null },
    }),
  ).toEqual(wasm);
  expect(
    await backendCandidates({
      ...isolated,
      gpu: { requestAdapter: async () => ({ features: new Set<string>() }) },
    }),
  ).toEqual(wasm);
  const requestAdapter = vi.fn().mockRejectedValue(new Error("Unavailable"));
  expect(
    await backendCandidates({ ...isolated, gpu: { requestAdapter } }),
  ).toEqual(wasm);
});

it("uses one WASM thread without isolation", async () => {
  expect(
    await backendCandidates({ ...isolated, crossOriginIsolated: false }),
  ).toEqual([{ provider: "wasm", threads: 1 }]);
});

it("falls back to WASM when a WebGPU session cannot be created", async () => {
  const candidates = await backendCandidates({
    ...isolated,
    gpu: { requestAdapter: async () => fp16Adapter },
  });
  const open = vi
    .fn()
    .mockRejectedValueOnce(new Error("Unsupported model"))
    .mockResolvedValue("ok");
  expect(await openBackend(candidates, open)).toEqual({
    backend: { provider: "wasm", threads: 8 },
    session: "ok",
  });
  expect(open).toHaveBeenNthCalledWith(1, { provider: "webgpu", threads: 8 });
});
