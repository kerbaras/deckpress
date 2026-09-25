import { type PrintSettings, papers, printSettingsSchema } from "./models.ts";

export const mmToPt = (mm: number) => (mm * 72) / 25.4;
export const mmToPixels = (mm: number, dpi: number) =>
  Math.round((mm * dpi) / 25.4);
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Slot extends Rect {
  trim: Rect;
}
export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface PrintLayout {
  width: number;
  height: number;
  columns: number;
  rows: number;
  slots: Slot[];
  guides: Guide[];
}

export function createLayout(input: PrintSettings): PrintLayout {
  const options = printSettingsSchema.parse(input);
  const paper =
    options.paper === "custom"
      ? [options.customWidthMm, options.customHeightMm]
      : papers[options.paper];
  const w = paper[0] ?? 210;
  const h = paper[1] ?? 297;
  const width = mmToPt(
    options.orientation === "portrait" ? Math.min(w, h) : Math.max(w, h),
  );
  const height = mmToPt(
    options.orientation === "portrait" ? Math.max(w, h) : Math.min(w, h),
  );
  const margin = mmToPt(options.marginMm);
  const gap = mmToPt(options.gapMm);
  const bleed = mmToPt(options.bleedMm);
  const cardWidth = mmToPt(options.cardWidthMm);
  const cardHeight = mmToPt(options.cardHeightMm);
  const cellWidth = cardWidth + 2 * bleed;
  const cellHeight = cardHeight + 2 * bleed;
  const maxColumns = Math.floor(
    (width - 2 * margin + gap + 0.0001) / (cellWidth + gap),
  );
  const maxRows = Math.floor(
    (height - 2 * margin + gap + 0.0001) / (cellHeight + gap),
  );
  const columns = options.columns || maxColumns;
  const rows = options.rows || maxRows;
  if (
    columns < 1 ||
    rows < 1 ||
    columns > maxColumns ||
    rows > maxRows ||
    columns * rows > 400
  )
    throw new Error(
      "Cards do not fit. Reduce the grid, margins, bleed or gap, or choose larger paper.",
    );
  const blockWidth = columns * cellWidth + (columns - 1) * gap;
  const blockHeight = rows * cellHeight + (rows - 1) * gap;
  const x0 = (width - blockWidth) / 2;
  const y0 = (height - blockHeight) / 2;
  const slots: Slot[] = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const x = x0 + column * (cellWidth + gap);
      const y = y0 + row * (cellHeight + gap);
      slots.push({
        x,
        y,
        width: cellWidth,
        height: cellHeight,
        trim: {
          x: x + bleed,
          y: y + bleed,
          width: cardWidth,
          height: cardHeight,
        },
      });
    }
  const guides: Guide[] = [];
  const xs = [
    ...new Set(slots.flatMap((slot) => [slot.trim.x, slot.trim.x + cardWidth])),
  ];
  const ys = [
    ...new Set(
      slots.flatMap((slot) => [slot.trim.y, slot.trim.y + cardHeight]),
    ),
  ];
  if (options.guides === "full") {
    for (const x of xs) guides.push({ x1: x, x2: x, y1: 0, y2: height });
    for (const y of ys) guides.push({ y1: y, y2: y, x1: 0, x2: width });
  } else if (options.guides === "crop") {
    const offset = mmToPt(options.guideOffsetMm);
    const length = mmToPt(options.guideLengthMm);
    const vertical = Math.min(length, y0 - offset - 0.5);
    const horizontal = Math.min(length, x0 - offset - 0.5);
    if (vertical > 0)
      for (const x of xs) {
        guides.push({
          x1: x,
          x2: x,
          y1: y0 - offset - vertical,
          y2: y0 - offset,
        });
        guides.push({
          x1: x,
          x2: x,
          y1: height - y0 + offset,
          y2: height - y0 + offset + vertical,
        });
      }
    if (horizontal > 0)
      for (const y of ys) {
        guides.push({
          y1: y,
          y2: y,
          x1: x0 - offset - horizontal,
          x2: x0 - offset,
        });
        guides.push({
          y1: y,
          y2: y,
          x1: width - x0 + offset,
          x2: width - x0 + offset + horizontal,
        });
      }
  }
  return { width, height, columns, rows, slots, guides };
}

export function duplexSlot(
  slot: Slot,
  layout: PrintLayout,
  settings: PrintSettings,
): Slot {
  const mirrorX =
    (settings.backs !== "short-edge") === layout.height >= layout.width;
  const dx = mmToPt(settings.backOffsetXmm);
  const dy = mmToPt(settings.backOffsetYmm);
  const transform = (rect: Rect): Rect => ({
    ...rect,
    x: (mirrorX ? layout.width - rect.x - rect.width : rect.x) + dx,
    y: (mirrorX ? rect.y : layout.height - rect.y - rect.height) + dy,
  });
  return { ...transform(slot), trim: transform(slot.trim) };
}
