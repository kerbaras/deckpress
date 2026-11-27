import {
  type UpscaleProgress,
  upscaleImage,
  upscaleModels,
} from "../upscale.ts";
import type { Timing } from "../worker-protocol.ts";
import { decodeRgb, encodePng } from "./image.ts";
import { installIsolation } from "./isolation.ts";
import "./style.css";

function get<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

const assetBase = new URL(".", location.href);
const file = get<HTMLInputElement>("file");
const model = get<HTMLSelectElement>("model");
const run = get<HTMLButtonElement>("run");
const cancel = get<HTMLButtonElement>("cancel");
const status = get("status");
const progress = get<HTMLProgressElement>("progress");
const original = get<HTMLImageElement>("original");
const result = get<HTMLImageElement>("result");
const download = get<HTMLAnchorElement>("download");
const dropZone = get("drop-zone");
let source: File | undefined;
let job: AbortController | undefined;

for (const spec of upscaleModels) model.add(new Option(spec.name, spec.id));

function clearResult() {
  if (result.src) URL.revokeObjectURL(result.src);
  result.removeAttribute("src");
  result.hidden = download.hidden = true;
  download.removeAttribute("href");
  get("result-size").textContent = "";
}

function showTiming(timing?: Timing) {
  get("backend").textContent = timing
    ? timing.provider === "webgpu"
      ? "WebGPU"
      : "WASM"
    : "—";
  get("threads").textContent = timing ? String(timing.threads) : "—";
  get("timing").textContent = timing?.msPerTile
    ? `${Math.round(timing.msPerTile)} ms`
    : "—";
}

function choose(picked: File | undefined) {
  if (job || !picked) return;
  source = picked;
  if (original.src) URL.revokeObjectURL(original.src);
  original.src = URL.createObjectURL(picked);
  original.hidden = false;
  get("original-size").textContent = "";
  clearResult();
  showTiming();
  run.disabled = false;
  status.textContent = picked.name;
}

function update(event: UpscaleProgress) {
  const { done, total } = event;
  progress.hidden = false;
  progress.max = total;
  progress.value = done;
  if (event.kind === "download") {
    status.textContent = `Downloading model · ${Math.floor((done / total) * 100)}%`;
  } else {
    showTiming(event.timing);
    status.textContent = `Upscaling · ${done} of ${total} tiles`;
  }
}

async function submit() {
  const spec = upscaleModels.find(({ id }) => id === model.value);
  if (!source || !spec || job) return;
  job = new AbortController();
  const { signal } = job;
  run.disabled = model.disabled = file.disabled = true;
  cancel.disabled = false;
  clearResult();
  showTiming();
  status.textContent = "Opening image and model…";
  try {
    const image = await decodeRgb(source);
    get("original-size").textContent = `${image.width} × ${image.height}`;
    const proof = await upscaleImage(image, spec, {
      assetBase,
      signal,
      onProgress: update,
    });
    status.textContent = "Encoding PNG…";
    const png = await encodePng(proof.image);
    signal.throwIfAborted();
    result.src = download.href = URL.createObjectURL(png);
    result.hidden = download.hidden = false;
    get("result-size").textContent =
      `${proof.image.width} × ${proof.image.height}`;
    showTiming(proof.timing);
    status.textContent = "PNG ready to download.";
  } catch (error) {
    status.textContent = signal.aborted
      ? "Upscaling cancelled."
      : error instanceof Error
        ? error.message
        : String(error);
  } finally {
    job = undefined;
    run.disabled = model.disabled = file.disabled = false;
    cancel.disabled = progress.hidden = true;
  }
}

file.addEventListener("change", () => choose(file.files?.[0]));
dropZone.addEventListener("dragover", (event) => event.preventDefault());
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  choose(event.dataTransfer?.files[0]);
});
cancel.addEventListener("click", () => job?.abort());
document.querySelector("form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});
void installIsolation(assetBase);
