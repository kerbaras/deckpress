import type { Art, PrintFailureTarget } from "../../core/index.ts";
import { downloadImage } from "../store/image-cache.ts";
import { decodeRgb, encodePng } from "../upscale/image.ts";
import { loadModel } from "../upscale/model-store.ts";
import { defaultWebModel, webModels } from "../upscale/models.ts";
import { openUpscaler } from "../upscale/session.ts";
import type { Timing } from "../upscale/worker-protocol.ts";
import { exportPlan } from "./plan.ts";
import type {
  PrintRequest,
  PrintResponse,
  PrintResult,
  SourceReading,
} from "./protocol.ts";

interface WasmPrint {
  default: () => Promise<unknown>;
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
  buildDuplexCalibrationPdf(settings: string): Uint8Array<ArrayBuffer>;
}

export class PrintError extends Error {
  readonly target: PrintFailureTarget;
  constructor(cause: unknown, target: PrintFailureTarget) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.target = target;
  }
}

function image(art: Art) {
  if (art.provider !== "scryfall")
    throw new Error(
      "This art source is unavailable on the web. Choose a Scryfall scan.",
    );
  return downloadImage(new URL(art.imageUrl));
}

function backendName(timing: Timing) {
  return timing.provider === "webgpu"
    ? "WebGPU"
    : `WASM · ${timing.threads} ${timing.threads === 1 ? "thread" : "threads"}`;
}

export async function print(
  request: PrintRequest,
  base: URL,
  send: (progress: Extract<PrintResponse, { kind: "progress" }>) => void,
): Promise<PrintResult> {
  const url = new URL("print/deckpress_core_wasm.js", base);
  const wasm: WasmPrint = await import(/* @vite-ignore */ url.href);
  await wasm.default();
  const settings = JSON.stringify(request.settings);
  if (request.kind === "svg")
    return { kind: "svg", text: wasm.buildCutSvg(settings) };
  if (request.kind === "calibration")
    return {
      kind: "calibration",
      file: new Blob([wasm.buildDuplexCalibrationPdf(settings)], {
        type: "application/pdf",
      }),
    };

  function reading(art: Art, width: number, height: number): SourceReading {
    return JSON.parse(
      wasm.assessSource(width, height, JSON.stringify(art), settings),
    );
  }
  if (request.kind === "source-dpi") {
    const readings = [];
    for (const art of request.arts) {
      try {
        const bitmap = await createImageBitmap(await image(art));
        try {
          readings.push(reading(art, bitmap.width, bitmap.height));
        } finally {
          bitmap.close();
        }
      } catch {
        readings.push(null);
      }
    }
    return { kind: "source-dpi", readings };
  }

  const { deck, format } = request;
  const { sources, faces, pdfPages } = exportPlan(deck, request.settings);
  const { signal } = new AbortController(); // The owner terminates this worker on cancel.
  const images = new Map<string, Uint8Array>();
  const model = request.settings.upscale
    ? webModels.find(
        ({ id }) => id === (request.settings.upscaleModel || defaultWebModel),
      )
    : undefined;
  if (request.settings.upscale && !model)
    throw new PrintError("Choose a browser upscaling model.", {
      kind: "upscaleModel",
    });

  let upscaler: Awaited<ReturnType<typeof openUpscaler>> | undefined;
  let completed = 0;
  let backend = "";
  const progress = (message: string) =>
    send({ kind: "progress", completed, total: sources.size, message });
  try {
    for (const [key, { art, name, entryId, back }] of sources) {
      const label = back ? `${name} back` : name;
      progress(`Preparing ${label}`);
      try {
        let source = await image(art);
        const rgb =
          model &&
          (await decodeRgb(
            source,
            request.settings.bleedColor,
            (width, height) =>
              reading(art, width, height).belowUpscaleThreshold,
          ));
        if (rgb && model) {
          if (!upscaler) {
            try {
              const bytes = await loadModel(
                model,
                base,
                signal,
                (done, total) =>
                  progress(
                    `Downloading ${model.name} · ${Math.floor((done * 100) / total)}%`,
                  ),
              );
              progress(`Loading ${model.name}`);
              upscaler = await openUpscaler(bytes, base);
            } catch (error) {
              throw new PrintError(error, { kind: "upscaleModel" });
            }
          }
          const result = await upscaler.run(
            rgb,
            signal,
            (done, total, timing) =>
              progress(
                `Upscaling ${label} · tile ${done}/${total} · ${backendName(timing)}`,
              ),
          );
          backend = backendName(result.timing);
          source = await encodePng(result.image);
        }
        images.set(key, new Uint8Array(await source.arrayBuffer()));
      } catch (error) {
        if (error instanceof PrintError) throw error;
        throw new PrintError(error, { kind: "card", entryId, back });
      }
      completed++;
    }
  } finally {
    await upscaler?.release();
  }
  const pdf = format === "pdf";
  progress(pdf ? "Building PDF…" : "Building PNG ZIP…");
  const bytes = (pdf ? wasm.buildPdf : wasm.buildPngZip)(
    JSON.stringify({ ...request.settings, upscale: Boolean(backend) }),
    JSON.stringify(deck),
    images,
  );
  return {
    kind: "export",
    file: new Blob([bytes], {
      type: pdf ? "application/pdf" : "application/zip",
    }),
    pages: pdf ? pdfPages : faces,
    total: sources.size,
    message: backend
      ? `Ready to download · AI upscaling on ${backend}`
      : "Ready to download",
  };
}
