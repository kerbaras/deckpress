import { afterEach, expect, it, vi } from "vitest";
import { deckSchema, printSettingsSchema } from "../../core/index.ts";
import { PRINT_INIT_TIMEOUT_MS, runPrintWorker, webJobs } from "./jobs.ts";
import type { PrintResponse } from "./protocol.ts";

const { createWorker } = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock("./print-worker.ts?worker", () => ({
  default: function PrintWorker() {
    return createWorker();
  },
}));

const settings = printSettingsSchema.parse({});
const calibration = { kind: "calibration", settings } as const;

function mockWorker() {
  const worker = {
    onmessage: (_event: { data: PrintResponse }) => {},
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
  createWorker.mockReturnValueOnce(worker);
  return worker;
}

afterEach(() => {
  createWorker.mockReset();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("does not start a browser print worker in a production desktop build", async () => {
  vi.stubEnv("PROD", true);
  vi.stubEnv("VITE_TARGET", "");

  await expect(
    runPrintWorker({
      kind: "calibration",
      settings: printSettingsSchema.parse({}),
    }),
  ).rejects.toThrow("The print worker is only available in the web app");
  expect(createWorker).not.toHaveBeenCalled();
});

it("fails a silent worker, advances the queue and allows a fresh retry with the original settings", async () => {
  vi.useFakeTimers();
  const silent = mockWorker();
  const queued = mockWorker();
  const retry = mockWorker();
  const now = new Date().toISOString();
  const deck = deckSchema.parse({
    id: crypto.randomUUID(),
    name: "Test deck",
    format: "Casual",
    entries: [],
    printSettings: settings,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
  const original = webJobs.create(deck, settings, "pdf");
  expect(webJobs.create(deck, settings, "png").status).toBe("queued");
  await vi.dynamicImportSettled();
  expect(silent.postMessage).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PRINT_INIT_TIMEOUT_MS - 1);
  expect(webJobs.list()[1]?.status).toBe("running");
  await vi.advanceTimersByTimeAsync(1);
  expect(silent.terminate).toHaveBeenCalledOnce();
  const [next, failed] = webJobs.list();
  expect(failed).toMatchObject({
    id: original.id,
    status: "failed",
    initTimedOut: true,
    message: expect.stringContaining("Print worker initialization timed out"),
  });
  expect(next?.status).toBe("running");
  await vi.dynamicImportSettled();
  expect(queued.postMessage).toHaveBeenCalledOnce();
  if (!next) throw new Error("Expected a queued export");
  webJobs.cancel(next.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(queued.terminate).toHaveBeenCalledOnce();
  if (!failed?.settings) throw new Error("Expected original export settings");
  const retried = webJobs.create(deck, failed.settings, failed.format);
  await vi.dynamicImportSettled();
  expect(retry.postMessage.mock.calls).toEqual(silent.postMessage.mock.calls);
  const result = {
    kind: "export",
    pages: 1,
    total: 1,
    message: "Ready to download",
    file: new Blob(["PDF"]),
  } as const;
  retry.onmessage({ data: { kind: "init", stage: "core", ready: true } });
  await vi.advanceTimersByTimeAsync(PRINT_INIT_TIMEOUT_MS);
  expect(webJobs.list()[0]?.status).toBe("running");
  retry.onmessage({ data: { kind: "result", result } });
  await vi.advanceTimersByTimeAsync(0);
  expect(webJobs.list()[0]).toMatchObject({
    id: retried.id,
    status: "completed",
  });
  expect(retry.terminate).toHaveBeenCalledOnce();
});

it("bounds model initialization separately without extending it for download progress", async () => {
  vi.useFakeTimers();
  const worker = mockWorker();
  const onProgress = vi.fn();
  const pending = runPrintWorker(calibration, undefined, onProgress);
  const failed = expect(pending).rejects.toThrow(
    "Upscaling model initialization timed out",
  );
  await vi.dynamicImportSettled();
  worker.onmessage({ data: { kind: "init", stage: "core", ready: true } });
  await vi.advanceTimersByTimeAsync(PRINT_INIT_TIMEOUT_MS);
  worker.onmessage({ data: { kind: "init", stage: "model", ready: false } });
  await vi.advanceTimersByTimeAsync(PRINT_INIT_TIMEOUT_MS - 1);
  worker.onmessage({
    data: { kind: "progress", completed: 0, total: 1, message: "Downloading" },
  });
  expect(onProgress).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await failed;
  expect(worker.terminate).toHaveBeenCalledOnce();
});
