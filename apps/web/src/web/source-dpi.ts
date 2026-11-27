import type { Art, PrintSettings } from "../core/index.ts";
import { webAssetBase } from "./asset-base.ts";
import { loadCoreWasm } from "./core-wasm.ts";
import { imageSrc } from "./store/image-cache.ts";
import { readUploadImage } from "./store/upload-files.ts";

async function sourceDimensions(art: Art) {
  if (art.provider === "upload") {
    const bitmap = await createImageBitmap(await readUploadImage(art.imageUrl));
    try {
      return [bitmap.width, bitmap.height] as const;
    } finally {
      bitmap.close();
    }
  }
  const src = imageSrc(art.imageUrl);
  if (src === "about:blank") throw new Error("Unrecognized source image");
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = src;
  await image.decode();
  return [image.naturalWidth, image.naturalHeight] as const;
}

export async function readPickerDpi(art: Art, settings: PrintSettings) {
  const [width, height] = await sourceDimensions(art);
  const wasm = await loadCoreWasm(webAssetBase());
  const { effectiveDpi } = JSON.parse(
    wasm.assessSource(
      width,
      height,
      JSON.stringify(art),
      JSON.stringify(settings),
    ),
  );
  return typeof effectiveDpi === "number" ? effectiveDpi : undefined;
}
