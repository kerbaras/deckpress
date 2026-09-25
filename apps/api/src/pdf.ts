import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Art,
  backArt,
  createLayout,
  type Deck,
  type DeckEntry,
  duplexSlot,
  frontArt,
  mmToPixels,
  type PrintSettings,
  printableEntries,
} from "@deckpress/core";
import { PDFDocument, type PDFImage, rgb, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { AppError } from "./errors.ts";
import type { Images } from "./images.ts";
import type { Upscaler } from "./upscaler.ts";

export async function rasterize(
  input: Buffer,
  art: Art,
  settings: PrintSettings,
  upscaler: Upscaler,
  signal: AbortSignal,
): Promise<Buffer> {
  let image = input;
  if (art.bleedMm > 0) {
    const metadata = await sharp(image).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const nativeWidth = art.provider === "mpc" ? 63.5 : settings.cardWidthMm;
    const nativeHeight = art.provider === "mpc" ? 88.9 : settings.cardHeightMm;
    const x = Math.round(
      (width * art.bleedMm) / (nativeWidth + art.bleedMm * 2),
    );
    const y = Math.round(
      (height * art.bleedMm) / (nativeHeight + art.bleedMm * 2),
    );
    image = await sharp(image)
      .extract({
        left: x,
        top: y,
        width: width - 2 * x,
        height: height - 2 * y,
      })
      .png()
      .toBuffer();
  }
  const targetWidth = mmToPixels(settings.cardWidthMm, settings.dpi);
  const targetHeight = mmToPixels(settings.cardHeightMm, settings.dpi);
  const source = await sharp(image).metadata();
  if (
    settings.upscale &&
    (source.width ?? 0) < targetWidth * 0.95 &&
    (source.height ?? 0) < targetHeight * 0.95
  )
    image = await upscaler.run(image, signal);
  signal.throwIfAborted();
  const bleed = mmToPixels(settings.bleedMm, settings.dpi);
  const face = await sharp(image, { limitInputPixels: 80_000_000 })
    .flatten({ background: settings.bleedColor })
    .resize(targetWidth, targetHeight, {
      fit: "contain",
      background: settings.bleedColor,
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();
  return sharp(face)
    .extend({
      top: bleed,
      bottom: bleed,
      left: bleed,
      right: bleed,
      extendWith:
        settings.bleedMode === "mirror"
          ? "mirror"
          : settings.bleedMode === "edge"
            ? "copy"
            : "background",
      background: settings.bleedColor,
    })
    .withMetadata({ density: settings.dpi })
    .jpeg({ quality: settings.quality, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

export function printPlan(deck: Deck, settings: PrintSettings) {
  const layout = createLayout(settings);
  const entries = printableEntries(deck, settings).flatMap((entry) =>
    Array.from({ length: entry.quantity }, () => entry),
  );
  if (!entries.length)
    throw new AppError("No cards are included in this print job", 422);
  const totalSheets = Math.ceil(entries.length / layout.slots.length);
  const first = settings.pageFrom - 1;
  const last = settings.pageTo
    ? Math.min(totalSheets, settings.pageTo)
    : totalSheets;
  if (first >= last) throw new AppError("Page range is outside the deck", 422);
  const sheets = Array.from({ length: last - first }, (_, index) =>
    entries.slice(
      (first + index) * layout.slots.length,
      (first + index + 1) * layout.slots.length,
    ),
  );
  const sides: { entries: DeckEntry[]; back: boolean }[] = [];
  for (const sheet of sheets) {
    sides.push({ entries: sheet, back: false });
    if (settings.backs === "long-edge" || settings.backs === "short-edge")
      sides.push({ entries: sheet, back: true });
  }
  if (settings.backs === "separate")
    for (const sheet of sheets) sides.push({ entries: sheet, back: true });
  return { layout, sides, totalSheets };
}

export async function buildPdf(
  deck: Deck,
  settings: PrintSettings,
  services: { images: Images; upscaler: Upscaler; root: string },
  signal: AbortSignal,
  progress: (completed: number, total: number, message: string) => void,
) {
  const { layout, sides } = printPlan(deck, settings);
  if (settings.upscale && !(await services.upscaler.status()).available)
    throw new AppError("Local AI upscaler is not configured", 503);
  const document = await PDFDocument.create();
  document.setTitle(`${deck.name} - playtest proxies`);
  document.setCreator("Deckpress");
  document.setSubject(
    `Print at 100% / actual size. ${settings.cardWidthMm} x ${settings.cardHeightMm} mm. ${settings.dpi} DPI raster target. ${settings.upscale ? "AI 4x enabled" : "Lanczos resizing; source detail unchanged"}.`,
  );
  const font = await document.embedFont(StandardFonts.Helvetica);
  const embedded = new Map<string, PDFImage>();
  const rasterDir = join(services.root, "raster");
  await mkdir(rasterDir, { recursive: true });
  const total = sides.reduce((n, side) => n + side.entries.length, 0);
  let completed = 0;
  let totalImageBytes = 0;
  const upscaleStatus = settings.upscale
    ? await services.upscaler.status()
    : null;
  for (const side of sides) {
    signal.throwIfAborted();
    const page = document.addPage([layout.width, layout.height]);
    for (const [index, entry] of side.entries.entries()) {
      signal.throwIfAborted();
      const originalSlot = layout.slots[index];
      if (!originalSlot) throw new Error("Print layout slot missing");
      const slot = side.back
        ? duplexSlot(originalSlot, layout, settings)
        : originalSlot;
      const art = side.back ? backArt(entry) : frontArt(entry);
      progress(
        completed,
        total,
        `${settings.upscale ? "Preparing / AI upscaling" : "Preparing"} ${entry.card.name}${side.back ? " · back" : ""}`,
      );
      if (art) {
        const source = await services.images.read(art.imageUrl);
        const key = createHash("sha256")
          .update(source)
          .update(
            JSON.stringify([
              art.bleedMm,
              art.provider,
              settings,
              upscaleStatus?.model,
            ]),
          )
          .digest("hex");
        let image = embedded.get(key);
        if (!image) {
          const path = join(rasterDir, `${key}.jpg`);
          let bytes: Buffer;
          try {
            bytes = await readFile(path);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
            bytes = await rasterize(
              source,
              art,
              settings,
              services.upscaler,
              signal,
            );
            await writeFile(path, bytes);
          }
          totalImageBytes += bytes.byteLength;
          if (totalImageBytes > 250 * 1024 * 1024)
            throw new AppError(
              "PDF exceeds 250 MB. Export a smaller page range or lower DPI.",
              413,
            );
          image = await document.embedJpg(bytes);
          embedded.set(key, image);
        }
        page.drawImage(image, {
          x: slot.x,
          y: layout.height - slot.y - slot.height,
          width: slot.width,
          height: slot.height,
        });
      } else {
        page.drawRectangle({
          x: slot.x,
          y: layout.height - slot.y - slot.height,
          width: slot.width,
          height: slot.height,
          color: rgb(0.08, 0.09, 0.1),
        });
        page.drawRectangle({
          x: slot.trim.x + 8,
          y: layout.height - slot.trim.y - slot.trim.height + 8,
          width: slot.trim.width - 16,
          height: slot.trim.height - 16,
          borderWidth: 1,
          borderColor: rgb(0.8, 0.63, 0.32),
        });
        page.drawText("DECKPRESS", {
          x: slot.trim.x + 22,
          y: layout.height - slot.trim.y - slot.trim.height / 2,
          font,
          size: 15,
          color: rgb(0.88, 0.7, 0.35),
        });
        page.drawText("PLAYTEST CARD", {
          x: slot.trim.x + 22,
          y: layout.height - slot.trim.y - slot.trim.height / 2 - 17,
          font,
          size: 8,
          color: rgb(0.7, 0.7, 0.7),
        });
      }
      completed++;
      progress(completed, total, `Placed ${completed} of ${total} card faces`);
    }
    const hex = settings.guideColor.slice(1);
    const color = rgb(
      Number.parseInt(hex.slice(0, 2), 16) / 255,
      Number.parseInt(hex.slice(2, 4), 16) / 255,
      Number.parseInt(hex.slice(4, 6), 16) / 255,
    );
    if (!side.back)
      for (const line of layout.guides)
        page.drawLine({
          start: { x: line.x1, y: layout.height - line.y1 },
          end: { x: line.x2, y: layout.height - line.y2 },
          thickness: settings.guideWidthPt,
          color,
        });
  }
  signal.throwIfAborted();
  return {
    bytes: await document.save(),
    pages: sides.length,
    uniqueImages: embedded.size,
  };
}
