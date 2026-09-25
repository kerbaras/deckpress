import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Deck,
  jobSchema,
  type PrintJob,
  type PrintSettings,
} from "@deckpress/core";
import { AppError } from "./errors.ts";
import type { Images } from "./images.ts";
import { buildPdf, printPlan } from "./pdf.ts";
import type { Store } from "./store.ts";
import type { Upscaler } from "./upscaler.ts";

export class Jobs {
  private tail: Promise<void> = Promise.resolve();
  private readonly controllers = new Map<string, AbortController>();
  readonly store: Store;
  readonly images: Images;
  readonly upscaler: Upscaler;
  readonly root: string;

  constructor(store: Store, images: Images, upscaler: Upscaler, root: string) {
    this.store = store;
    this.images = images;
    this.upscaler = upscaler;
    this.root = root;
    for (const job of store.list("job", jobSchema))
      if (job.status === "running" || job.status === "queued")
        store.put("job", job.id, {
          ...job,
          status: "failed",
          message: "The API restarted. Start a new export to resume.",
        });
  }

  create(deck: Deck, settings: PrintSettings): PrintJob {
    if (this.controllers.size >= 8)
      throw new AppError(
        "The local print queue is full. Wait for an export to finish.",
        429,
      );
    const { sides } = printPlan(deck, settings);
    const id = randomUUID();
    const job: PrintJob = {
      id,
      deckId: deck.id,
      deckName: deck.name,
      status: "queued",
      completed: 0,
      total: sides.reduce((n, side) => n + side.entries.length, 0),
      message: "Waiting for local worker",
      createdAt: new Date().toISOString(),
      fileName: `${deck.name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "deck"}-${settings.paper}-${settings.dpi}dpi.pdf`,
      bytes: 0,
      pages: sides.length,
    };
    this.store.put("job", id, job);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const update = (changes: Partial<PrintJob>) => {
      Object.assign(job, changes);
      this.store.put("job", id, job);
    };
    this.tail = this.tail.then(async () => {
      try {
        controller.signal.throwIfAborted();
        update({ status: "running", message: "Preparing print images" });
        const result = await buildPdf(
          deck,
          settings,
          this,
          controller.signal,
          (completed, total, message) => update({ completed, total, message }),
        );
        controller.signal.throwIfAborted();
        await mkdir(join(this.root, "jobs"), { recursive: true });
        await writeFile(join(this.root, "jobs", `${id}.pdf`), result.bytes);
        update({
          status: "completed",
          bytes: result.bytes.byteLength,
          pages: result.pages,
          message: "Ready. Print at 100% / actual size; turn off fit to page.",
        });
      } catch (error) {
        update({
          status: controller.signal.aborted ? "cancelled" : "failed",
          message: controller.signal.aborted
            ? "Export cancelled"
            : error instanceof AppError
              ? error.message
              : "Export failed. Check the API output and retry.",
        });
        if (!controller.signal.aborted)
          console.error("Print job failed:", error);
      } finally {
        this.controllers.delete(id);
      }
    });
    return { ...job };
  }

  cancel(id: string) {
    this.controllers.get(id)?.abort(new Error("Export cancelled"));
  }

  async close() {
    for (const controller of this.controllers.values())
      controller.abort(new Error("Server stopped"));
    await this.tail;
  }
}
