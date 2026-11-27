export type RgbImage = {
  width: number;
  height: number;
  pixels: Uint8Array;
};

type Geometry = { tile: number; overlap: number; scale: number };
type Progress = (done: number, total: number) => void;

export const ESRGAN = { tile: 256, overlap: 24, scale: 4 } as const;

export function reflect(index: number, length: number): number {
  if (length <= 1) return 0;
  const period = 2 * (length - 1);
  const m = ((index % period) + period) % period;
  return m >= length ? period - m : m;
}

export function feather(size: number, ramp: number): Float32Array {
  return Float32Array.from({ length: size }, (_, i) =>
    ramp === 0 ? 1 : Math.min((i + 0.5) / ramp, (size - i - 0.5) / ramp, 1),
  );
}

export function positions(
  length: number,
  tile: number,
  step: number,
): number[] {
  const end = Math.max(0, length - tile);
  const positions = [0];
  for (let p = 0; p < end; ) {
    p = Math.min(p + step, end);
    positions.push(p);
  }
  return positions;
}

function readTile(
  image: RgbImage,
  x0: number,
  y0: number,
  tile: number,
): Float32Array {
  const { width, height, pixels } = image;
  const plane = tile * tile;
  const input = new Float32Array(3 * plane);
  const xs = Array.from({ length: tile }, (_, x) => reflect(x0 + x, width));
  for (let y = 0; y < tile; y++) {
    const row = reflect(y0 + y, height) * width;
    for (let x = 0; x < tile; x++) {
      const src = (row + (xs[x] as number)) * 3;
      const dst = y * tile + x;
      input[dst] = (pixels[src] as number) / 255;
      input[dst + plane] = (pixels[src + 1] as number) / 255;
      input[dst + 2 * plane] = (pixels[src + 2] as number) / 255;
    }
  }
  return input;
}

type Blend = {
  width: number;
  height: number;
  accum: Float32Array;
  weight: Float32Array;
  ramp: Float32Array;
};

function blendTile(blend: Blend, output: Float32Array, x0: number, y0: number) {
  const { width, height, accum, weight, ramp } = blend;
  const size = ramp.length;
  const plane = size * size;
  const maxX = Math.min(size, width - x0);
  const maxY = Math.min(size, height - y0);
  for (let y = 0; y < maxY; y++) {
    for (let x = 0; x < maxX; x++) {
      const w = Math.fround((ramp[y] as number) * (ramp[x] as number));
      const dst = (y0 + y) * width + x0 + x;
      const src = y * size + x;
      weight[dst] = (weight[dst] as number) + w;
      for (let c = 0; c < 3; c++) {
        const i = 3 * dst + c;
        accum[i] =
          (accum[i] as number) +
          Math.fround((output[c * plane + src] as number) * w);
      }
    }
  }
}

function normalize({ accum, weight }: Blend): Uint8Array {
  const pixels = new Uint8Array(accum.length);
  for (let i = 0; i < weight.length; i++) {
    const w = weight[i] as number;
    const norm = w > Math.fround(1e-6) ? Math.fround(1 / w) : 0;
    for (let c = 0; c < 3; c++) {
      const j = 3 * i + c;
      const value = Math.max(
        0,
        Math.min(1, Math.fround((accum[j] as number) * norm)),
      );
      pixels[j] = Math.fround(value * 255 + 0.5);
    }
  }
  return pixels;
}

export async function upscaleTiles(
  image: RgbImage,
  run: (input: Float32Array) => Promise<Float32Array>,
  signal: AbortSignal,
  progress?: Progress,
  { tile, overlap, scale }: Geometry = ESRGAN,
): Promise<RgbImage> {
  if (image.width < 1 || image.height < 1)
    throw new Error("Cannot upscale an empty image");
  signal.throwIfAborted();

  const step = tile - Math.min(overlap, Math.floor(tile / 2));
  const xs = positions(image.width, tile, step);
  const ys = positions(image.height, tile, step);
  const total = xs.length * ys.length;
  const width = image.width * scale;
  const height = image.height * scale;
  const outTile = tile * scale;
  const blend = {
    width,
    height,
    ramp: feather(outTile, (tile - step) * scale),
    accum: new Float32Array(width * height * 3),
    weight: new Float32Array(width * height),
  };

  let done = 0;
  progress?.(done, total);
  for (const y of ys) {
    for (const x of xs) {
      signal.throwIfAborted();
      const output = await run(readTile(image, x, y, tile));
      signal.throwIfAborted();
      if (output.length < 3 * outTile * outTile)
        throw new Error("Model output is too short");
      blendTile(blend, output, x * scale, y * scale);
      done++;
      progress?.(done, total);
    }
  }
  signal.throwIfAborted();
  return { width, height, pixels: normalize(blend) };
}
