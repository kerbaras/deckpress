import type { RgbImage } from "./tiling.ts";

function canvasContext(width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not open an image canvas");
  return ctx;
}

export async function decodeRgb(
  file: Blob,
  background = "#000000",
  shouldDecode = (_width: number, _height: number) => true,
): Promise<RgbImage | null> {
  const bitmap = await createImageBitmap(file, {
    colorSpaceConversion: "none",
  });
  const { width, height } = bitmap;
  try {
    if (!shouldDecode(width, height)) return null;
    const ctx = canvasContext(width, height);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const pixels = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      pixels[i * 3] = rgba[i * 4] as number;
      pixels[i * 3 + 1] = rgba[i * 4 + 1] as number;
      pixels[i * 3 + 2] = rgba[i * 4 + 2] as number;
    }
    return { width, height, pixels };
  } finally {
    bitmap.close();
  }
}

export function encodePng({ width, height, pixels }: RgbImage): Promise<Blob> {
  const ctx = canvasContext(width, height);
  const rgba = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    rgba.data[i * 4] = pixels[i * 3] as number;
    rgba.data[i * 4 + 1] = pixels[i * 3 + 1] as number;
    rgba.data[i * 4 + 2] = pixels[i * 3 + 2] as number;
    rgba.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(rgba, 0, 0);
  return ctx.canvas.convertToBlob({ type: "image/png" });
}
