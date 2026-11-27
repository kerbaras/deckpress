interface CoreWasm {
  default: () => Promise<unknown>;
  setFamily(chosen: string, sets: string): string;
  setCoverage(entries: string, sets: string): string;
  assessSource(
    width: number,
    height: number,
    art: string,
    settings: string,
  ): string;
  buildPdf(
    settings: string,
    deck: string,
    images: Map<string, Uint8Array>,
  ): Uint8Array<ArrayBuffer>;
  buildPngZip(
    settings: string,
    deck: string,
    images: Map<string, Uint8Array>,
  ): Uint8Array<ArrayBuffer>;
  buildCutSvg(settings: string): string;
  buildCutDxf(settings: string): string;
  buildCutStudio3(
    settings: string,
    archive: Uint8Array,
  ): Uint8Array<ArrayBuffer>;
  buildDuplexCalibrationPdf(settings: string): Uint8Array<ArrayBuffer>;
}

let loaded: Promise<CoreWasm> | undefined;

export function loadCoreWasm(base: URL) {
  const url = new URL("print/deckpress_core_wasm.js", base);
  loaded ??= (async () => {
    const wasm: CoreWasm = await import(/* @vite-ignore */ url.href);
    await wasm.default();
    return wasm;
  })().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });
  return loaded;
}
