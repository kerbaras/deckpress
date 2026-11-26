import source from "../../../../packages/core/assets/scm/layouts.json";
import { mmToPt, type PrintLayout, type Rect, type Slot } from "./layout.ts";
import type { PrintSettings, ScmTemplate } from "./models.ts";

export const MAX_SCM_BLEED_MM = 0.625;
const GAP_MM = 1.25;
const CORNER_PADDING_MM = 1.5;

type Orientation = PrintSettings["orientation"];
type Pair = [number, number];
type Registration = { inset: string; thickness: string; length: string };
type Dimensions = { width: string; height: string };
type Template = {
  orientation: string;
  version: number;
  registration: Partial<Registration>;
};
type Variants = Record<ScmTemplate["variant"], Template>;
const layouts: Record<string, Record<string, Variants>> = source.layouts;
const paperSizes: Record<string, Dimensions> = source.paper_sizes;
const cardSizes: Record<string, Dimensions> = source.card_sizes;

export const scmPapers = Object.keys(layouts);
export const scmCards = (paper: string) =>
  Object.hasOwn(layouts, paper) ? Object.keys(layouts[paper] ?? {}).sort() : [];

export interface ScmSheet {
  name: string;
  marks: Rect[];
  orientation: Orientation;
}

const sizeMm = (size: string) =>
  Number.parseFloat(size) * (size.endsWith("in") ? 25.4 : 1);
const roundEven = (n: number) =>
  n % 1 === 0.5 && Math.floor(n) % 2 === 0 ? Math.floor(n) : Math.round(n);
const mmToScmPx = (mm: number) => roundEven((mm / 25.4) * source.ppi);
const sizePx = (size: string) =>
  size.endsWith("in")
    ? roundEven(Number.parseFloat(size) * source.ppi)
    : mmToScmPx(sizeMm(size));
const pxToPt = (px: number) => mmToPt((px * 25.4) / source.ppi);

export function scmRasterSettings(settings: PrintSettings): PrintSettings {
  if (settings.layoutMode !== "scm") return settings;
  const card = cardSizes[settings.scmTemplate.card];
  if (!Object.hasOwn(cardSizes, settings.scmTemplate.card) || !card) {
    throw new Error("Unknown SCM paper and card template");
  }
  return {
    ...settings,
    cardWidthMm: (sizePx(card.width) * 25.4) / source.ppi,
    cardHeightMm: (sizePx(card.height) * 25.4) / source.ppi,
    bleedMm: Math.min(settings.bleedMm, MAX_SCM_BLEED_MM),
  };
}

function grid(
  [w, h]: Pair,
  [cw, ch]: Pair,
  gap: number,
  inset: number,
  corner: number,
): Pair {
  let best: Pair = [0, 0];
  for (const [mx, my] of [
    [inset, inset],
    [inset + corner, inset],
    [inset, inset + corner],
  ] satisfies Pair[]) {
    const uw = w - 2 * mx;
    const uh = h - 2 * my;
    const cols = Math.floor((uw + gap) / (cw + gap));
    const rows = Math.floor((uh + gap) / (ch + gap));
    const colsClear = Math.floor(
      (uw - gap - 2 * (corner - mx + inset)) / (cw + gap),
    );
    const rowsClear = Math.floor(
      (uh - gap - 2 * (corner - my + inset)) / (ch + gap),
    );
    for (const [c, r] of [
      [cols, rows],
      [colsClear, rows],
      [cols, rowsClear],
    ] satisfies Pair[]) {
      const cx = (w - c * (cw + gap) - gap) / 2 - inset;
      const cy = (h - r * (ch + gap) - gap) / 2 - inset;
      if (
        c > 0 &&
        r > 0 &&
        c * r > best[0] * best[1] &&
        (cx >= corner || cy >= corner)
      ) {
        best = [c, r];
      }
    }
  }
  if (!best[0]) throw new Error("Cards do not fit the SCM template");
  return best;
}

function registrationMarks(
  [w, h]: Pair,
  inset: number,
  length: number,
  thickness: number,
  marks: ScmTemplate["marks"],
): Rect[] {
  const half = thickness / 2;
  const rect = (x: number, y: number, width: number, height: number): Rect => ({
    x: mmToPt(x),
    y: mmToPt(y),
    width: mmToPt(width),
    height: mmToPt(height),
  });
  const out: Rect[] = [];
  for (const [right, bottom] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const x = right ? w - inset : inset;
    const y = bottom ? h - inset : inset;
    if (marks === 3 && !right && !bottom) {
      out.push(rect(x - half, y - half, 5 + thickness, 5 + thickness));
    } else if (marks === 4 || !right || !bottom) {
      out.push(
        rect(right ? x - length : x - half, y - half, length + half, thickness),
      );
      out.push(
        rect(
          x - half,
          bottom ? y - length : y - half,
          thickness,
          length + half,
        ),
      );
    }
  }
  return out;
}

export function createScmLayout(settings: PrintSettings): PrintLayout {
  const selection = settings.scmTemplate;
  const cards = Object.hasOwn(layouts, selection.paper)
    ? layouts[selection.paper]
    : undefined;
  const template =
    cards && Object.hasOwn(cards, selection.card)
      ? cards[selection.card]?.[selection.variant]
      : undefined;
  const paper = paperSizes[selection.paper];
  const card = cardSizes[selection.card];
  if (!template || !paper || !card) {
    throw new Error("Unknown SCM paper and card template");
  }
  const defaults = source.defaults.registration;
  const reg = { ...defaults[selection.variant], ...template.registration };
  const inset = sizeMm(reg.inset);
  const orientation =
    template.orientation === "portrait" ? "portrait" : "landscape";
  const paperWidth = orientation === "portrait" ? paper.height : paper.width;
  const paperHeight = orientation === "portrait" ? paper.width : paper.height;
  const w = sizePx(paperWidth);
  const h = sizePx(paperHeight);
  const cw = sizePx(card.width);
  const ch = sizePx(card.height);
  const gap = mmToScmPx(GAP_MM);
  const exclusion = sizeMm(defaults.default.length) + CORNER_PADDING_MM;
  const [columns, rows] = grid(
    [w, h],
    [cw, ch],
    gap,
    mmToScmPx(inset),
    mmToScmPx(exclusion),
  );
  const x0 = roundEven((w - columns * cw - (columns - 1) * gap) / 2);
  const y0 = roundEven((h - rows * ch - (rows - 1) * gap) / 2);
  const bleed = mmToPt(Math.min(settings.bleedMm, MAX_SCM_BLEED_MM));
  const slots: Slot[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const trim = {
        x: pxToPt(x0 + col * (cw + gap)),
        y: pxToPt(y0 + row * (ch + gap)),
        width: pxToPt(cw),
        height: pxToPt(ch),
      };
      slots.push({
        x: trim.x - bleed,
        y: trim.y - bleed,
        width: trim.width + 2 * bleed,
        height: trim.height + 2 * bleed,
        trim,
      });
    }
  }
  const pageMm: Pair = [sizeMm(paperWidth), sizeMm(paperHeight)];
  const width = mmToPt(pageMm[0]);
  const height = mmToPt(pageMm[1]);
  const variant = selection.variant === "default" ? "" : "-borderless";
  return {
    width,
    height,
    columns,
    rows,
    slots,
    guides: [],
    registration: [],
    labelBaseline: height - mmToPt(1),
    scm: {
      name: `${selection.paper}-${selection.card}${variant}-v${template.version}`,
      marks: registrationMarks(
        pageMm,
        inset,
        Math.max(5, Math.min(20, sizeMm(reg.length))),
        sizeMm(reg.thickness),
        selection.marks,
      ),
      orientation,
    },
  };
}

export function scmDuplexSlot(
  slot: Slot,
  layout: PrintLayout,
  settings: PrintSettings,
): Slot {
  const first = layout.slots[0] ?? slot;
  const last = layout.slots.at(-1) ?? slot;
  const portrait = layout.height >= layout.width;
  const transform = (rect: Rect, first: Rect, last: Rect): Rect => ({
    ...rect,
    x:
      (portrait ? first.x + last.x - rect.x : rect.x) +
      mmToPt(settings.backOffsetXmm),
    y:
      (portrait ? rect.y : first.y + last.y - rect.y) +
      mmToPt(settings.backOffsetYmm),
  });
  return {
    ...transform(slot, first, last),
    trim: transform(slot.trim, first.trim, last.trim),
  };
}
