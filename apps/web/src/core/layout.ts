import scmData from "../../../../packages/core/assets/scm/layouts.json";
import {
  type PrintSettings,
  papers,
  printSettingsSchema,
  type ScmTemplate,
} from "./models.ts";

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
/** Circle-and-crosshair target printed on both sides of a duplex sheet. */
export interface Registration {
  x: number;
  y: number;
  radius: number;
}
export interface PrintLayout {
  width: number;
  height: number;
  columns: number;
  rows: number;
  slots: Slot[];
  guides: Guide[];
  registration: Registration[];
  registrationInk: Rect[];
  templateName: string | null;
  /** Baseline of the sheet label in the bottom margin, if there is room. */
  labelBaseline: number | null;
}

export const REGISTRATION_RADIUS_MM = 1.5;
export const LABEL_SIZE_PT = 5;
export const SCM_MAX_BLEED_MM = 0.625;

interface TemplateMarks {
  name: string;
  count: ScmTemplate["marks"];
  inset: number;
  thickness: number;
  length: number;
}

interface GridTemplate {
  paper: readonly [number, number];
  card: readonly [number, number];
  orientation: PrintSettings["orientation"];
  insetMm: number;
  gapMm: number;
  ppi: number | null;
  cornerMm: number;
  marks: TemplateMarks | null;
}

type Dimensions = { width: string; height: string };
type TemplateData = {
  orientation: PrintSettings["orientation"];
  version: number;
  registration: { length: string };
};
type ScmLayouts = Record<
  string,
  Record<string, Record<ScmTemplate["variant"], TemplateData>>
>;
const layouts = scmData.layouts as ScmLayouts;
const paperSizes: Record<string, Dimensions> = scmData.paper_sizes;
const cardSizes: Record<string, Dimensions> = scmData.card_sizes;

export const scmPapers = Object.keys(layouts);
export const scmCards = (paper: string) => Object.keys(layouts[paper] ?? {});
const sizeMm = (size: string) =>
  Number(size.slice(0, -2)) * (size.endsWith("in") ? 25.4 : 1);

function gridTemplate(options: PrintSettings): GridTemplate {
  if (options.layoutMode === "free") {
    return {
      paper:
        options.paper === "custom"
          ? [options.customWidthMm, options.customHeightMm]
          : papers[options.paper],
      card: [options.cardWidthMm, options.cardHeightMm],
      orientation: options.orientation,
      insetMm: options.marginMm,
      gapMm: options.gapMm,
      ppi: null,
      cornerMm: 0,
      marks: null,
    };
  }
  const { paper, card, variant, marks } = options.scmTemplate;
  const layout =
    Object.hasOwn(layouts, paper) && Object.hasOwn(cardSizes, card)
      ? layouts[paper]?.[card]?.[variant]
      : undefined;
  const paperSize = paperSizes[paper];
  const cardSize = cardSizes[card];
  if (!layout || !paperSize || !cardSize)
    throw new Error("Unknown SCM template");
  const style = scmData.defaults.registration[variant];
  const insetMm = sizeMm(style.inset);
  const suffix = variant === "borderless" ? "-borderless" : "";
  return {
    paper: [sizeMm(paperSize.width), sizeMm(paperSize.height)],
    card: [sizeMm(cardSize.width), sizeMm(cardSize.height)],
    orientation: layout.orientation,
    insetMm,
    gapMm: 1.25,
    ppi: scmData.ppi,
    cornerMm: sizeMm(style.length) + 1.5,
    marks: {
      name: `${paper}-${card}${suffix}-v${layout.version}`,
      count: marks,
      inset: mmToPt(insetMm),
      thickness: mmToPt(sizeMm(style.thickness)),
      length: mmToPt(
        Math.min(20, Math.max(5, sizeMm(layout.registration.length))),
      ),
    },
  };
}

function registrationInk(
  marks: TemplateMarks,
  width: number,
  height: number,
): Rect[] {
  const { count, inset, thickness, length } = marks;
  const half = thickness / 2;
  const rects: Rect[] = [];
  for (const [right, bottom] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    if (count === 3 && right && bottom) continue;
    const x = right ? width - inset : inset;
    const y = bottom ? height - inset : inset;
    if (count === 3 && !right && !bottom) {
      const size = mmToPt(5) + thickness;
      rects.push({ x: x - half, y: y - half, width: size, height: size });
    } else {
      rects.push(
        {
          x: right ? x - length : x - half,
          y: y - half,
          width: length + half,
          height: thickness,
        },
        {
          x: x - half,
          y: bottom ? y - length : y + half,
          width: thickness,
          height: length - half,
        },
      );
    }
  }
  return rects;
}

function roundTiesEven(value: number) {
  const lower = Math.floor(value);
  return value - lower === 0.5 && lower % 2 === 0 ? lower : Math.round(value);
}

export function createLayout(input: PrintSettings): PrintLayout {
  const options = printSettingsSchema.parse(input);
  const template = gridTemplate(options);
  const { ppi, marks } = template;
  const units = (mm: number) =>
    ppi === null ? mmToPt(mm) : roundTiesEven((mm / 25.4) * ppi);
  const points = (value: number) => (ppi === null ? value : (value * 72) / ppi);
  const [w, h] = template.paper;
  const portrait = template.orientation === "portrait";
  const width = units(portrait ? Math.min(w, h) : Math.max(w, h));
  const height = units(portrait ? Math.max(w, h) : Math.min(w, h));
  const margin = units(template.insetMm);
  const gap = units(template.gapMm);
  const scm = ppi !== null;
  const bleed = mmToPt(
    scm ? Math.min(options.bleedMm, SCM_MAX_BLEED_MM) : options.bleedMm,
  );
  const cardWidth = units(template.card[0]);
  const cardHeight = units(template.card[1]);
  const fitBleed = scm ? 0 : bleed;
  const cellWidth = cardWidth + 2 * fitBleed;
  const cellHeight = cardHeight + 2 * fitBleed;
  const tolerance = scm ? 0 : 0.0001;
  const maxColumns = Math.floor(
    (width - 2 * margin + gap + tolerance) / (cellWidth + gap),
  );
  const maxRows = Math.floor(
    (height - 2 * margin + gap + tolerance) / (cellHeight + gap),
  );
  let columns = (!scm && options.columns) || maxColumns;
  let rows = (!scm && options.rows) || maxRows;
  if (scm) {
    const corner = units(template.cornerMm);
    const clear = (page: number, cell: number) =>
      Math.floor((page - gap - 2 * (margin + corner)) / (cell + gap));
    const clearColumns = Math.min(clear(width, cellWidth), maxColumns);
    const clearRows = Math.min(clear(height, cellHeight), maxRows);
    if (columns > clearColumns && rows > clearRows) {
      if (clearColumns * rows >= columns * clearRows) columns = clearColumns;
      else rows = clearRows;
    }
  }
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
  const center = (page: number, block: number) =>
    scm ? roundTiesEven((page - block) / 2) : (page - block) / 2;
  const x0 = center(width, blockWidth);
  const y0 = center(height, blockHeight);
  const slots: Slot[] = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const x = points(x0 + column * (cellWidth + gap));
      const y = points(y0 + row * (cellHeight + gap));
      slots.push({
        x: scm ? x - bleed : x,
        y: scm ? y - bleed : y,
        width: points(cellWidth) + (scm ? 2 * bleed : 0),
        height: points(cellHeight) + (scm ? 2 * bleed : 0),
        trim: {
          x: x + fitBleed,
          y: y + fitBleed,
          width: points(cardWidth),
          height: points(cardHeight),
        },
      });
    }
  if (marks)
    return {
      width: points(width),
      height: points(height),
      columns,
      rows,
      slots,
      guides: [],
      registration: [],
      registrationInk: registrationInk(marks, points(width), points(height)),
      templateName: marks.name,
      labelBaseline: points(height) - mmToPt(1),
    };
  const guides: Guide[] = [];
  const registration: Registration[] = [];
  let labelBaseline: number | null = null;
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
    // Corner marks for every card: a tick along each trim-line extension in
    // every interior gutter, inset by the offset so no ink reaches the trim.
    const gutter = 2 * bleed + gap;
    if (gutter - 2 * offset > mmToPt(0.2)) {
      for (let row = 1; row < rows; row++) {
        const top = y0 + row * (cellHeight + gap);
        for (const x of xs)
          guides.push({
            x1: x,
            x2: x,
            y1: top - gap - bleed + offset,
            y2: top + bleed - offset,
          });
      }
      for (let column = 1; column < columns; column++) {
        const left = x0 + column * (cellWidth + gap);
        for (const y of ys)
          guides.push({
            y1: y,
            y2: y,
            x1: left - gap - bleed + offset,
            x2: left + bleed - offset,
          });
      }
    }
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
  if (options.guides !== "none") {
    const radius = mmToPt(REGISTRATION_RADIUS_MM);
    const clearance = radius + mmToPt(1);
    const duplex =
      options.backs === "long-edge" || options.backs === "short-edge";
    if (duplex) {
      if (y0 / 2 >= clearance)
        registration.push({ x: width / 2, y: y0 / 2, radius });
      if (x0 / 2 >= clearance) {
        registration.push({ x: x0 / 2, y: height / 2, radius });
        registration.push({ x: width - x0 / 2, y: height / 2, radius });
      }
    }
    const marksEnd =
      options.guides === "crop"
        ? mmToPt(options.guideOffsetMm + options.guideLengthMm)
        : 0;
    const baseline = height - y0 + marksEnd + LABEL_SIZE_PT * 1.6;
    if (height - baseline >= mmToPt(4)) labelBaseline = baseline;
  }
  return {
    width,
    height,
    columns,
    rows,
    slots,
    guides,
    registration,
    registrationInk: [],
    templateName: null,
    labelBaseline,
  };
}

export function effectiveBacks(
  settings: PrintSettings,
): PrintSettings["backs"] {
  return settings.layoutMode === "scm" && settings.backs === "short-edge"
    ? "long-edge"
    : settings.backs;
}

export function scmRotatesBack(layout: PrintLayout) {
  return layout.templateName !== null && layout.width > layout.height;
}

export function effectivePrintSettings(
  settings: PrintSettings,
  layout: PrintLayout | null,
): PrintSettings {
  const trim = layout?.templateName && layout.slots[0]?.trim;
  if (!trim) return settings;
  return {
    ...settings,
    cardWidthMm: (trim.width * 25.4) / 72,
    cardHeightMm: (trim.height * 25.4) / 72,
    bleedMm: Math.min(settings.bleedMm, SCM_MAX_BLEED_MM),
    backs: effectiveBacks(settings),
  };
}

export function duplexSlot(
  slot: Slot,
  layout: PrintLayout,
  settings: PrintSettings,
): Slot {
  const mirrorX =
    (effectiveBacks(settings) !== "short-edge") ===
    layout.height >= layout.width;
  const dx = mmToPt(settings.backOffsetXmm);
  const dy = mmToPt(settings.backOffsetYmm);
  // SCM reverses the occupied row/column indices, including the rounded grid origin.
  const first = layout.slots[0]?.trim;
  const last = layout.slots.at(-1)?.trim;
  const [width, height] =
    layout.templateName && first && last
      ? [first.x + last.x + last.width, first.y + last.y + last.height]
      : [layout.width, layout.height];
  const transform = (rect: Rect): Rect => ({
    ...rect,
    x: (mirrorX ? width - rect.x - rect.width : rect.x) + dx,
    y: (mirrorX ? rect.y : height - rect.y - rect.height) + dy,
  });
  return { ...transform(slot), trim: transform(slot.trim) };
}
