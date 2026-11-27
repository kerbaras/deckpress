import { useEffect, useState } from "react";
import { isWebPreview } from "../api.ts";
import type { Art } from "../core/index.ts";
import type { PreviewSettings } from "./backend/types.ts";
import { readUploadImage } from "./store/upload-files.ts";
import { uploadSnapshot } from "./upload-wasm.ts";

const pending = new Map<string, Promise<Blob>>();

function load(
  key: string,
  source: string,
  art: string,
  mode: boolean | string,
) {
  const existing = pending.get(key);
  if (existing) return existing;
  const result = Promise.resolve()
    .then(() => readUploadImage(source))
    .then((file) => (art ? uploadSnapshot(file, art, mode) : file))
    .finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

export interface UploadImage {
  src: string | undefined;
  failed: boolean;
}

/** Browser object URL for a web upload; `src` stays unset until it loads. */
export function useUploadImage(
  art: Art,
  mode: boolean | PreviewSettings,
): UploadImage {
  const source =
    isWebPreview() && art.provider === "upload" ? art.imageUrl : "";
  const artJson =
    source && (typeof mode !== "boolean" || art.bleedMm > 0)
      ? JSON.stringify(art)
      : "";
  const variant = typeof mode === "boolean" ? mode : JSON.stringify(mode);
  const key = JSON.stringify([source, artJson, variant]);
  const [image, setImage] = useState<{ key: string } & UploadImage>();
  useEffect(() => {
    if (!source) return;
    let active = true;
    let url: string | undefined;
    void load(key, source, artJson, variant).then(
      (blob) => {
        if (!active) return;
        url = URL.createObjectURL(blob);
        setImage({ key, src: url, failed: false });
      },
      () => {
        if (active) setImage({ key, src: undefined, failed: true });
      },
    );
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, source, artJson, variant]);
  return image?.key === key ? image : { src: undefined, failed: false };
}
