import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ask, save } from "@tauri-apps/plugin-dialog";
import type { StyleProgress } from "../../api.ts";
import type { Backend } from "./types.ts";

const IMAGE_SCHEME = "dpimg";

export const tauriBackend: Backend = {
  call: (name, args) => invoke(name, args),
  uploadArt: (bytes, meta, filename) =>
    invoke("upload_art", bytes, {
      headers: {
        "x-deckpress-upload": encodeURIComponent(
          JSON.stringify({ ...meta, filename }),
        ),
      },
    }),
  matchArtStyle: (request, onProgress) => {
    const progress = new Channel<StyleProgress>();
    progress.onmessage = (message) => onProgress?.(message);
    return invoke("match_art_style", { request, progress });
  },
  imageSrc: (url) => convertFileSrc(`image/${url}`, IMAGE_SCHEME),
  uploadTrimSrc: ({ imageUrl, bleedMm }, thumbnail = false) =>
    convertFileSrc(
      `upload-trim/${JSON.stringify({ imageUrl, bleedMm, ...(thumbnail && { thumbnail }) })}`,
      IMAGE_SCHEME,
    ),
  comparisonThumbnailSrc: (art, settings) =>
    convertFileSrc(
      `comparison-thumbnail/${JSON.stringify({ art, settings })}`,
      IMAGE_SCHEME,
    ),
  previewSrc: (art, settings) =>
    convertFileSrc(
      `preview/${JSON.stringify({ art, settings })}`,
      IMAGE_SCHEME,
    ),
  save,
  ask,
};
