import type { Art, PrintFailureTarget } from "../../core/index.ts";
import { loadCoreWasm } from "../core-wasm.ts";
import { downloadImage } from "../store/image-cache.ts";
import { readUploadImage } from "../store/upload-files.ts";
import { decodeRgb, encodePng } from "../upscale/image.ts";
import { loadModel } from "../upscale/model-store.ts";
import { defaultWebModel, webModels } from "../upscale/models.ts";
import { openUpscaler } from "../upscale/session.ts";
import type { Timing } from "../upscale/worker-protocol.ts";
import { exportPlan } from "./plan.ts";
import type {
  PrintRequest,
  PrintResult,
  PrintUpdate,
  SourceReading,
} from "./protocol.ts";

export class PrintError extends Error {
  readonly target: PrintFailureTarget;
  constructor(cause: unknown, target: PrintFailureTarget) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.target = target;
  }
}

function image(art: Art) {
  if (art.provider === "upload") return readUploadImage(art.imageUrl);
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
  send: (update: PrintUpdate) => void,
): Promise<PrintResult> {
  console.debug("[deckpress:print] loading core WASM module and binary", {
    isolated: globalThis.crossOriginIsolated,
  });
  const wasm = await loadCoreWasm(base);
  send({ kind: "init", stage: "core", ready: true });
  const settings = JSON.stringify(request.settings);
  if (request.kind === "cut") {
    if (request.format === "studio3") {
      const response = await fetch(
        new URL("print/cutting-templates.zip", base),
      );
      if (!response.ok)
        throw new Error(
          `Could not load the Silhouette templates (${response.status}).`,
        );
      const archive = new Uint8Array(await response.arrayBuffer());
      return {
        kind: "cut",
        file: new Blob([wasm.buildCutStudio3(settings, archive)], {
          type: "application/octet-stream",
        }),
      };
    }
    const svg = request.format === "svg";
    return {
      kind: "cut",
      file: new Blob(
        [svg ? wasm.buildCutSvg(settings) : wasm.buildCutDxf(settings)],
        {
          type: svg ? "image/svg+xml" : "image/vnd.dxf",
        },
      ),
    };
  }
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
    const readings: (SourceReading | null)[] = [];
    const sources = request.arts.entries();
    async function readSources() {
      for (const [index, art] of sources) {
        try {
          const bitmap = await createImageBitmap(await image(art));
          try {
            readings[index] = reading(art, bitmap.width, bitmap.height);
          } finally {
            bitmap.close();
          }
        } catch {
          readings[index] = null;
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(4, request.arts.length) }, readSources),
    );
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
  const modelReady = (ready: boolean) =>
    send({ kind: "init", stage: "model", ready });
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
              modelReady(false);
              console.debug("[deckpress:print] loading model bytes", model.id);
              const bytes = await loadModel(
                model,
                base,
                signal,
                (done, total) =>
                  progress(
                    `Downloading ${model.name} · ${Math.floor((done * 100) / total)}%`,
                  ),
              );
              console.debug("[deckpress:print] model bytes ready", model.id);
              progress(`Loading ${model.name}`);
              upscaler = await openUpscaler(bytes, base);
              modelReady(true);
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
            modelReady,
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
