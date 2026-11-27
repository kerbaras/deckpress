import type {
  Deck,
  PrintFailureTarget,
  PrintJob,
  PrintSettings,
} from "../../core/index.ts";
import { webAssetBase } from "../asset-base.ts";
import { downloadBlob } from "../backend/download.ts";
import {
  addReloadBlocker,
  notifyReloadCheck,
  trackReloadWork,
} from "../pwa/register.ts";
import { exportFileName } from "../store/settings.ts";
import type {
  PrintInitStage,
  PrintRequest,
  PrintResponse,
  PrintResult,
} from "./protocol.ts";

export const PRINT_INIT_TIMEOUT_MS = 30_000;

class PrintInitTimeout extends Error {
  constructor(stage: PrintInitStage) {
    const component = stage === "core" ? "Print worker" : "Upscaling model";
    super(
      `${component} initialization timed out. Retry, or reload the page if it keeps failing.`,
    );
  }
}

class WorkerFailure extends Error {
  readonly target: PrintFailureTarget | undefined;
  constructor(message: string, target?: PrintFailureTarget) {
    super(message);
    this.target = target;
  }
}

export function runPrintWorker(
  request: PrintRequest,
  signal?: AbortSignal,
  onProgress?: (event: Extract<PrintResponse, { kind: "progress" }>) => void,
): Promise<PrintResult> {
  return trackReloadWork(runPrintWorkerInner(request, signal, onProgress));
}

async function runPrintWorkerInner(
  request: PrintRequest,
  signal?: AbortSignal,
  onProgress?: (event: Extract<PrintResponse, { kind: "progress" }>) => void,
): Promise<PrintResult> {
  signal?.throwIfAborted();
  if (import.meta.env.PROD && import.meta.env.VITE_TARGET !== "web")
    throw new Error("The print worker is only available in the web app");
  let worker: Worker | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise((resolve, reject) => {
      let stage: PrintInitStage | undefined = "core";
      const resetInitTimer = () => {
        clearTimeout(timer);
        const pending = stage;
        if (!pending) return;
        timer = setTimeout(() => {
          console.debug("[deckpress:print] init timeout", pending);
          reject(new PrintInitTimeout(pending));
        }, PRINT_INIT_TIMEOUT_MS);
      };
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      resetInitTimer();
      console.debug("[deckpress:print] loading worker", {
        request: request.kind,
        isolated: globalThis.crossOriginIsolated,
        controlled: !!navigator.serviceWorker?.controller,
      });
      void import("./print-worker.ts?worker")
        .then(({ default: PrintWorker }) => {
          if (finished || signal?.aborted) return;
          worker = new PrintWorker();
          console.debug("[deckpress:print] worker spawned");
          resetInitTimer();
          worker.onmessage = ({ data }: MessageEvent<PrintResponse>) => {
            if (data.kind === "init") {
              console.debug(
                "[deckpress:print] init",
                data.stage,
                data.ready ? "ready" : "starting",
              );
              stage = data.ready ? undefined : data.stage;
            }
            resetInitTimer();
            if (data.kind === "progress") onProgress?.(data);
            else if (data.kind === "result") resolve(data.result);
            else if (data.kind === "error")
              reject(new WorkerFailure(data.message, data.target));
          };
          worker.onerror = (event) =>
            reject(
              new Error(event.message || "The print worker could not start"),
            );
          worker.onmessageerror = () =>
            reject(new Error("Could not read the print worker response"));
          worker.postMessage({ request, base: webAssetBase().href });
        })
        .catch(reject);
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    worker?.terminate();
  }
}

type JobRecord = { job: PrintJob; deck?: Deck; file?: Blob };
const records = new Map<string, JobRecord>();
let active: { id: string; controller: AbortController } | undefined;

function hasPendingOrUnsavedJobs() {
  for (const { job } of records.values()) {
    if (
      job.status === "queued" ||
      job.status === "running" ||
      (job.status === "completed" && !job.downloadStarted)
    )
      return true;
  }
  return false;
}

addReloadBlocker(hasPendingOrUnsavedJobs);

async function next() {
  if (active) return;
  const record = [...records.values()].find(
    ({ job }) => job.status === "queued",
  );
  if (!record?.deck || !record.job.settings) return;
  const { job, deck } = record;
  const settings = record.job.settings;
  delete record.deck;
  const controller = new AbortController();
  active = { id: job.id, controller };
  job.status = "running";
  job.message = "Starting print worker…";
  try {
    const result = await runPrintWorker(
      { kind: "export", format: job.format, deck, settings },
      controller.signal,
      ({ completed, total, message }) =>
        Object.assign(job, { completed, total, message }),
    );
    if (result.kind !== "export")
      throw new Error("Invalid print worker response");
    controller.signal.throwIfAborted();
    record.file = result.file;
    Object.assign(job, {
      status: "completed",
      completed: result.total,
      total: result.total,
      pages: result.pages,
      bytes: result.file.size,
      message: result.message,
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      job.status = "failed";
      job.message = error instanceof Error ? error.message : String(error);
      if (error instanceof PrintInitTimeout) job.initTimedOut = true;
      if (error instanceof WorkerFailure && error.target)
        job.failureTarget = error.target;
    }
  } finally {
    active = undefined;
    notifyReloadCheck();
    void next();
  }
}

export const webJobs = {
  list: () => [...records.values()].reverse().map(({ job }) => ({ ...job })),
  create(deck: Deck, settings: PrintSettings, format: PrintJob["format"]) {
    const job: PrintJob = {
      id: crypto.randomUUID(),
      deckId: deck.id,
      deckName: deck.name,
      createdAt: new Date().toISOString(),
      status: "queued",
      message: "Waiting to export",
      completed: 0,
      total: 0,
      pages: 0,
      bytes: 0,
      fileName: exportFileName(
        deck.name,
        format === "pdf" ? ".pdf" : "-png.zip",
      ),
      calibrationPage: format === "pdf" && settings.calibrationPage,
      format,
      settings,
    };
    records.set(job.id, { job, deck });
    void next();
    return { ...job };
  },
  cancel(id: string) {
    const record = records.get(id);
    if (!record) throw new Error("Export not found");
    if (record.job.status === "queued" || record.job.status === "running") {
      record.job.status = "cancelled";
      record.job.message = "Export cancelled";
      delete record.deck;
      if (active?.id === id) active.controller.abort();
      notifyReloadCheck();
    }
    return { ...record.job };
  },
  save(id: string, destination: string) {
    const record = records.get(id);
    if (!record?.file) throw new Error("This export is not ready to download");
    downloadBlob(destination, record.file);
    record.job.downloadStarted = true;
    notifyReloadCheck();
    return record.file.size;
  },
  get busy() {
    return !!active;
  },
  hasPendingOrUnsaved: hasPendingOrUnsavedJobs,
};
