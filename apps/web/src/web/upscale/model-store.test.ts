import { createHash, webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { readModel } from "./model-store.ts";

const url = new URL("https://deckpress.example/models/proof.onnx");
const good = "good";
const bad = "fake";
const spec = {
  file: "proof.onnx",
  bytes: good.length,
  sha256: createHash("sha256").update(good).digest("hex"),
};

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});

function store(initial?: string) {
  let cached = initial;
  return {
    match: vi.fn(async () => (cached ? new Response(cached) : undefined)),
    put: vi.fn(async (_key: string, value: Response) => {
      cached = await value.text();
    }),
    delete: vi.fn(async () => {
      cached = undefined;
      return true;
    }),
  };
}

it("uses verified cached bytes without fetching", async () => {
  const download = vi.fn().mockRejectedValue(new Error("Offline"));
  const bytes = await readModel(
    spec,
    url,
    store(good),
    new AbortController().signal,
    undefined,
    download,
  );
  expect(new TextDecoder().decode(bytes)).toBe(good);
  expect(download).not.toHaveBeenCalled();
});

it("deletes a corrupt cached model, re-downloads, and verifies before putting it back", async () => {
  const cache = store(bad);
  const signal = new AbortController().signal;
  const progress = vi.fn();
  const download = vi.fn().mockImplementation(async () => new Response(good));
  const bytes = await readModel(spec, url, cache, signal, progress, download);
  expect(new TextDecoder().decode(bytes)).toBe(good);
  expect(cache.delete).toHaveBeenCalledWith(url.href);
  expect(download).toHaveBeenCalledExactlyOnceWith(url.href, {
    signal,
    cache: "no-store",
    mode: "same-origin",
  });
  expect(cache.put).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenLastCalledWith(spec.bytes, spec.bytes);
});

it("retries a bad download once and rejects without caching if still invalid", async () => {
  const cache = store();
  const download = vi.fn().mockImplementation(async () => new Response(bad));
  await expect(
    readModel(
      spec,
      url,
      cache,
      new AbortController().signal,
      undefined,
      download,
    ),
  ).rejects.toThrow("Model SHA-256 does not match");
  expect(download).toHaveBeenCalledTimes(2);
  expect(cache.put).not.toHaveBeenCalled();
});

it("does not cache a download cancelled at the progress callback", async () => {
  const cache = store();
  const controller = new AbortController();
  const download = vi.fn().mockImplementation(async () => new Response(good));
  await expect(
    readModel(
      spec,
      url,
      cache,
      controller.signal,
      () => controller.abort(),
      download,
    ),
  ).rejects.toThrow();
  expect(cache.put).not.toHaveBeenCalled();
});

it("cancels a stalled stream reader immediately when aborted", async () => {
  const cache = store();
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(enqueue) {
      enqueue.enqueue(new TextEncoder().encode("go"));
    },
  });
  const download = vi.fn().mockResolvedValue(new Response(stream));
  const pending = readModel(
    spec,
    url,
    cache,
    controller.signal,
    (done) => {
      if (done === 2) controller.abort(new Error("stalled"));
    },
    download,
  );
  await expect(pending).rejects.toThrow("stalled");
  expect(cache.put).not.toHaveBeenCalled();
});
