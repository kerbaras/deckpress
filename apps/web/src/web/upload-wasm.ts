import { webAssetBase } from "./asset-base.ts";
import type { UploadMetadata } from "./backend/types.ts";

interface PreparedUpload {
  metadata: string;
  png: Uint8Array<ArrayBuffer>;
  free(): void;
}

interface UploadWasm {
  default(): Promise<unknown>;
  prepareUpload(
    bytes: Uint8Array,
    input: string,
    id: string,
    releasedAt: string,
  ): PreparedUpload;
  setUploadBleed(bytes: Uint8Array, metadata: string, bleed?: number): string;
  uploadSnapshot(
    bytes: Uint8Array,
    art: string,
    thumbnail: boolean,
  ): Uint8Array<ArrayBuffer>;
  uploadPreview(
    bytes: Uint8Array,
    art: string,
    settings: string,
  ): Uint8Array<ArrayBuffer>;
}

let wasm: Promise<UploadWasm> | undefined;

function loadUploadWasm() {
  async function load() {
    const url = new URL("print/deckpress_core_wasm.js", webAssetBase());
    const module: UploadWasm = await import(/* @vite-ignore */ url.href);
    await module.default();
    return module;
  }
  wasm ??= load().catch((error: unknown) => {
    wasm = undefined;
    throw error;
  });
  return wasm;
}

export const uploadProcessing = {
  async prepare(
    bytes: Uint8Array,
    meta: UploadMetadata,
    id: string,
    date: string,
  ) {
    const module = await loadUploadWasm();
    const upload = module.prepareUpload(bytes, JSON.stringify(meta), id, date);
    try {
      return { metadata: upload.metadata, png: upload.png };
    } finally {
      upload.free();
    }
  },
  async setBleed(file: File, metadata: string, bleed: number | null) {
    const module = await loadUploadWasm();
    return module.setUploadBleed(
      new Uint8Array(await file.arrayBuffer()),
      metadata,
      bleed ?? undefined,
    );
  },
};

export async function uploadSnapshot(
  file: File,
  art: string,
  mode: boolean | string,
) {
  const module = await loadUploadWasm();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return typeof mode === "boolean"
    ? new Blob([module.uploadSnapshot(bytes, art, mode)], { type: "image/png" })
    : new Blob([module.uploadPreview(bytes, art, mode)], {
        type: "image/jpeg",
      });
}
