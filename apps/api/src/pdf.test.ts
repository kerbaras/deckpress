import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artSchema,
  type DeckEntry,
  mmToPixels,
  mmToPt,
  printSettingsSchema,
} from "@deckpress/core";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { expect, it } from "vitest";
import { Images } from "./images.ts";
import { buildPdf, printPlan, rasterize } from "./pdf.ts";
import { Store } from "./store.ts";
import { Upscaler } from "./upscaler.ts";

it("builds a multi-page duplex PDF with exact paper dimensions and one embedded image per unique art", async () => {
  const root = await mkdtemp(join(tmpdir(), "deckpress-pdf-"));
  const store = new Store(":memory:");
  const images = new Images(root, store);
  const upscaler = new Upscaler(root);
  const id = "a4f5c8d1-0903-40be-8f8c-e9dcb5aa7240";
  try {
    const png = await sharp({
      create: { width: 630, height: 880, channels: 3, background: "#527367" },
    })
      .png()
      .toBuffer();
    const art = await images.upload(png, {
      oracleId: id,
      name: "Test card",
      artist: "Test",
      bleedMm: 0,
    });
    const entry: DeckEntry = {
      id,
      card: {
        id,
        oracleId: id,
        name: "Test card",
        typeLine: "Creature",
        manaCost: "{1}",
        manaValue: 1,
        colors: ["G"],
        faces: [art],
      },
      quantity: 10,
      zone: "main",
      selectedArt: null,
      selectedBack: art,
      excluded: false,
    };
    const deck = store.createDeck({
      name: "Test print",
      format: "Casual",
      entries: [entry],
    });
    const settings = printSettingsSchema.parse({
      dpi: 300,
      backs: "long-edge",
    });
    const result = await buildPdf(
      deck,
      settings,
      { images, upscaler, root },
      new AbortController().signal,
      () => {},
    );
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(4);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(mmToPt(210));
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(mmToPt(297));
    expect(result.uniqueImages).toBe(1);
    expect(
      printPlan(deck, { ...settings, pageFrom: 2, pageTo: 2 }).sides,
    ).toHaveLength(2);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      buildPdf(
        deck,
        settings,
        { images, upscaler, root },
        controller.signal,
        () => {},
      ),
    ).rejects.toThrow("cancelled");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("crops pre-existing bleed before adding requested bleed and embeds the requested raster density", async () => {
  const source = await sharp({
    create: { width: 822, height: 1122, channels: 4, background: "#ff0000" },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 750,
            height: 1050,
            channels: 4,
            background: "#00ff00",
          },
        })
          .png()
          .toBuffer(),
        left: 36,
        top: 36,
      },
    ])
    .png()
    .toBuffer();
  const art = artSchema.parse({
    id: "mpc:test",
    provider: "mpc",
    name: "Test",
    imageUrl: "https://drive.google.com/test",
    thumbnailUrl: "https://drive.google.com/test",
    source: "Test",
    bleedMm: 3.048,
  });
  const settings = printSettingsSchema.parse({
    cardWidthMm: 63.5,
    cardHeightMm: 88.9,
    dpi: 300,
    bleedMm: 1,
    bleedMode: "edge",
  });
  const output = await rasterize(
    source,
    art,
    settings,
    new Upscaler("/unused"),
    new AbortController().signal,
  );
  const metadata = await sharp(output).metadata();
  expect(metadata.width).toBe(mmToPixels(63.5, 300) + 2 * mmToPixels(1, 300));
  expect(metadata.density).toBe(300);
  const stats = await sharp(output).stats();
  expect(stats.channels[0]?.mean).toBeLessThan(5);
  expect(stats.channels[1]?.mean).toBeGreaterThan(245);
});
