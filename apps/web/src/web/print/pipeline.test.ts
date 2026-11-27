import { expect, it, vi } from "vitest";
import { artSchema, printSettingsSchema } from "../../core/index.ts";
import { loadCoreWasm } from "../core-wasm.ts";
import { downloadImage } from "../store/image-cache.ts";
import { print } from "./pipeline.ts";

vi.mock("../core-wasm.ts");
vi.mock("../store/image-cache.ts");

it("overlaps a bounded number of DPI decodes and preserves input order on errors", async () => {
  const base = new URL("https://example.com/");
  const arts = Array.from({ length: 9 }, (_, index) =>
    artSchema.parse({
      id: String(index),
      name: "Opt",
      provider: "scryfall",
      imageUrl: new URL(String(index), base).href,
      thumbnailUrl: new URL(String(index), base).href,
      source: "fixture",
    }),
  );
  vi.mocked(downloadImage).mockImplementation(async (url) => {
    return new Blob([url.pathname.slice(1)]);
  });
  vi.mocked(loadCoreWasm, { partial: true }).mockResolvedValue({
    assessSource: (width) => JSON.stringify({ width }),
  });
  const decodes = new Map<number, PromiseWithResolvers<ImageBitmap>>();
  const decode = vi.fn(async (blob: Blob) => {
    const id = Number(await blob.text());
    const task = Promise.withResolvers<ImageBitmap>();
    decodes.set(id, task);
    return task.promise;
  });
  vi.stubGlobal("createImageBitmap", decode);
  const close = vi.fn();
  const finish = (index: number) =>
    decodes.get(index)?.resolve({ width: index, height: 1, close });
  const pending = print(
    { kind: "source-dpi", arts, settings: printSettingsSchema.parse({}) },
    base,
    vi.fn(),
  );
  await vi.waitFor(() => expect(decodes.size).toBe(4));
  expect(decode).toHaveBeenCalledTimes(4);
  finish(2);
  await vi.waitFor(() => expect(decodes.size).toBe(5));
  expect(decode).toHaveBeenCalledTimes(5);
  decodes.get(1)?.reject(new Error("Bad scan"));
  await vi.waitFor(() => expect(decodes.size).toBe(6));
  [0, 3, 4, 5].forEach(finish);
  await vi.waitFor(() => expect(decodes.size).toBe(9));
  [6, 7, 8].forEach(finish);
  await expect(pending).resolves.toEqual({
    kind: "source-dpi",
    readings: arts.map((_, width) => (width === 1 ? null : { width })),
  });
  expect(close).toHaveBeenCalledTimes(8);
});
