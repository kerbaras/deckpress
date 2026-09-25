import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artSchema,
  deckSchema,
  healthResponseSchema,
  jobSchema,
  printSettingsSchema,
} from "@deckpress/core";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { Store } from "./store.ts";

const application = createApp({ store: new Store(":memory:") });
const { app } = application;
afterAll(() => application.close());

describe("API", () => {
  it("serves the shared health contract with security and request headers", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: "ok",
      service: "@deckpress/api",
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("creates a complete deck from minimal input and rejects stale or cross-site edits", async () => {
    const request = (
      path: string,
      method: string,
      value: unknown,
      headers = {},
    ) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(value),
      });
    const created = await request("/api/decks", "POST", {
      name: "Burn",
      format: "Modern",
    });
    expect(created.status).toBe(201);
    const deck = deckSchema.parse(await created.json());
    expect(deck.entries).toEqual([]);
    expect(deck.printSettings.dpi).toBe(600);
    const updated = await request(`/api/decks/${deck.id}`, "PUT", {
      ...deck,
      name: "Boros Burn",
    });
    expect(deckSchema.parse(await updated.json()).revision).toBe(1);
    expect((await request(`/api/decks/${deck.id}`, "PUT", deck)).status).toBe(
      409,
    );
    expect(
      (
        await request(
          "/api/decks",
          "POST",
          { name: "Rejected", format: "Modern" },
          { Origin: "https://untrusted.example" },
        )
      ).status,
    ).toBe(403);
  });

  it("uploads a card, renders matching bleed previews, and downloads a finished PDF job", async () => {
    const root = await mkdtemp(join(tmpdir(), "deckpress-api-"));
    const instance = createApp({ dataDir: root, store: new Store(":memory:") });
    const request = instance.app.request.bind(instance.app);
    const id = "a4f5c8d1-0903-40be-8f8c-e9dcb5aa7240";
    try {
      const image = await sharp({
        create: { width: 630, height: 880, channels: 3, background: "#347759" },
      })
        .png()
        .toBuffer();
      const form = new FormData();
      form.set(
        "image",
        new File([new Uint8Array(image)], "card.png", { type: "image/png" }),
      );
      form.set("oracleId", id);
      form.set("name", "Test card");
      const uploaded = await request("/api/uploads", {
        method: "POST",
        body: form,
      });
      expect(uploaded.status).toBe(201);
      const art = artSchema.parse(await uploaded.json());
      const settings = printSettingsSchema.parse({
        dpi: 300,
        bleedMm: 2,
        bleedMode: "mirror",
      });
      const preview = await request(
        `/api/preview?${new URLSearchParams({ art: JSON.stringify(art), settings: JSON.stringify(settings) })}`,
      );
      expect(preview.status).toBe(200);
      const metadata = await sharp(
        Buffer.from(await preview.arrayBuffer()),
      ).metadata();
      expect(metadata.density).toBe(150);
      expect(metadata.width).toBe(
        Math.round((63 * 150) / 25.4) + 2 * Math.round((2 * 150) / 25.4),
      );
      const deck = instance.store.createDeck({
        name: "API proof",
        format: "Casual",
        entries: [
          {
            id,
            card: {
              id,
              oracleId: id,
              name: "Test card",
              typeLine: "Instant",
              manaCost: "",
              manaValue: 0,
              colors: [],
              faces: [art],
            },
            quantity: 2,
            zone: "main",
            selectedArt: null,
            selectedBack: null,
            excluded: false,
          },
        ],
      });
      const queued = await request("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId: deck.id, settings }),
      });
      expect(queued.status).toBe(202);
      const job = jobSchema.parse(await queued.json());
      await vi.waitFor(() =>
        expect(instance.store.get("job", job.id, jobSchema)?.status).toBe(
          "completed",
        ),
      );
      const download = await request(`/api/jobs/${job.id}/download`);
      expect(download.headers.get("content-type")).toBe("application/pdf");
      const pdf = await PDFDocument.load(await download.arrayBuffer());
      expect(pdf.getPageCount()).toBe(1);
      const blocked = await request(
        `/api/preview?${new URLSearchParams({ art: JSON.stringify({ ...art, imageUrl: "http://127.0.0.1/private" }), settings: "{}" })}`,
      );
      expect(blocked.status).toBe(403);
    } finally {
      await instance.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const response = await app.request("/api/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
