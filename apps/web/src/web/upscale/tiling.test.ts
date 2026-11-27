import { describe, expect, it, vi } from "vitest";
import { feather, positions, reflect, upscaleTiles } from "./tiling.ts";

describe("desktop tiling", () => {
  it("mirrors without repeating the edge", () => {
    expect([
      reflect(5, 5),
      reflect(4, 5),
      reflect(8, 5),
      reflect(3, 1),
    ]).toEqual([3, 4, 0, 0]);
    expect(reflect(-1, 5)).toBe(1);
  });

  it("uses a symmetric ramp with full weight in the middle", () => {
    expect([...feather(8, 2)]).toEqual([0.25, 0.75, 1, 1, 1, 1, 0.75, 0.25]);
  });

  it("clamps the last tile to the edge and covers a Scryfall PNG in 20 tiles", () => {
    expect(positions(10, 16, 12)).toEqual([0]);
    expect(positions(40, 16, 12)).toEqual([0, 12, 24]);
    expect(positions(41, 16, 12)).toEqual([0, 12, 24, 25]);
    expect(positions(745, 256, 232)).toEqual([0, 232, 464, 489]);
    expect(positions(1040, 256, 232)).toEqual([0, 232, 464, 696, 784]);
  });

  it("reproduces nearest-neighbour exactly on the Rust test's odd-sized image", async () => {
    const width = 37;
    const height = 29;
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        pixels.set(
          [(x * 7) % 256, (y * 5) % 256, (x + y) % 256],
          3 * (y * width + x),
        );
      }
    }
    const nearest = async (input: Float32Array) =>
      Float32Array.from({ length: 3 * 32 * 32 }, (_, i) => {
        const c = Math.floor(i / 1024);
        const x = i % 32;
        const y = Math.floor(i / 32) % 32;
        return input[c * 256 + (y >> 1) * 16 + (x >> 1)] as number;
      });
    const progress = vi.fn();
    const out = await upscaleTiles(
      { width, height, pixels },
      nearest,
      new AbortController().signal,
      progress,
      { tile: 16, scale: 2, overlap: 4 },
    );
    expect([out.width, out.height]).toEqual([74, 58]);
    expect(out.pixels).toEqual(
      Uint8Array.from(out.pixels, (_, i) => {
        const x = Math.floor(i / 3) % 74;
        const y = Math.floor(i / (74 * 3));
        return pixels[3 * ((y >> 1) * width + (x >> 1)) + (i % 3)] as number;
      }),
    );
    expect(progress).toHaveBeenNthCalledWith(1, 0, 9);
    expect(progress).toHaveBeenLastCalledWith(9, 9);
  });

  it("blends differing tiles and clips bottom padding", async () => {
    let tileIndex = 0;
    const result = await upscaleTiles(
      { width: 12, height: 1, pixels: new Uint8Array(36) },
      async (tile) => new Float32Array(tile.length).fill(tileIndex++),
      new AbortController().signal,
      undefined,
      { tile: 8, scale: 1, overlap: 4 },
    );
    expect(result.height).toBe(1);
    expect([...result.pixels.filter((_, i) => i % 3 === 0)]).toEqual([
      0, 0, 0, 0, 32, 96, 159, 223, 255, 255, 255, 255,
    ]);
  });

  it("stops before inference when cancelled", async () => {
    const run = vi.fn();
    await expect(
      upscaleTiles(
        { width: 1, height: 1, pixels: new Uint8Array(3) },
        run,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
