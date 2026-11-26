import { describe, expect, it } from "vitest";
import facePixelCases from "../../../../packages/core/tests/fixtures/face-pixels.json";
import labelNumbers from "../../../../packages/core/tests/fixtures/sheet-label-numbers.json";
import {
  createLayout,
  duplexRotation,
  duplexSlot,
  facePixels,
  fitSheetLabel,
  mmToPt,
  sheetLabel,
} from "./layout.ts";
import { printSettingsSchema } from "./models.ts";

describe("print geometry", () => {
  it("labels the exact trim, bleed and DPI on a back sheet", () => {
    const settings = printSettingsSchema.parse({
      cardWidthMm: 63.5,
      cardHeightMm: 88.9,
      bleedMm: 0.625,
      dpi: 600,
    });
    expect(sheetLabel(settings, " Proof ★ ", 2, 3, true)).toBe(
      "PROOF / SHEET 2 OF 3 / BACKS / TRIM 63.5 × 88.9 mm / 0.625 mm BLEED / 600 DPI / PRINT AT 100%",
    );
  });

  it.each(facePixelCases)(
    "rounds $widthMm x $heightMm mm + $bleedMm mm bleed at $dpi DPI once",
    (vector) => {
      expect(
        facePixels(vector.widthMm, vector.heightMm, vector.bleedMm, vector.dpi),
      ).toEqual({
        trimWidth: vector.width - 2 * vector.bleed,
        trimHeight: vector.height - 2 * vector.bleed,
        bleed: vector.bleed,
      });
    },
  );

  it.each(labelNumbers)("formats sheet labels as $expected", (vector) => {
    const wire = JSON.stringify(JSON.parse(vector.settings));
    expect(wire).toBe(vector.settings);
    const settings = printSettingsSchema.parse(JSON.parse(wire));
    expect(sheetLabel(settings, "Proof", 1, 1, false)).toBe(
      `PROOF / SHEET 1 OF 1 / FRONTS / ${vector.expected} / PRINT AT 100%`,
    );
  });

  it.each([
    {
      customWidthMm: 115,
      customHeightMm: 180,
      cardWidthMm: 63.5,
      cardHeightMm: 88.9,
      bleedMm: 0.625,
      dpi: 300,
      expected:
        "QA PRINT PROOF / SHEET 1 OF 11 / FRONTS / TRIM 63.5 × 88.9 mm / 0.625 mm BLEED / 300 DPI / PRINT AT 100%",
    },
    {
      customWidthMm: 40,
      customHeightMm: 40,
      cardWidthMm: 25,
      cardHeightMm: 25,
      bleedMm: 0,
      dpi: 150,
      guides: "full",
      expected:
        "QA PRINT PROOF / SHEET 1 OF 11 / FRONTS / TRIM 25 × 25 mm / 0 mm BLEED / 150 DPI / PRINT AT 100%",
    },
  ])("fits the complete sheet label on $customWidthMm mm paper", (vector) => {
    const settings = printSettingsSchema.parse({ paper: "custom", ...vector });
    const layout = createLayout(settings);
    const sheets = Math.ceil(11 / layout.slots.length);
    const text = sheetLabel(settings, "QA print proof ★", 1, sheets, false);
    expect(text).toBe(vector.expected);
    const placement = fitSheetLabel(layout, text);
    if (!placement) throw new Error("Missing fitted sheet label");
    expect(placement.x).toBe(layout.slots[0]?.x);
    expect(placement.baseline).toBe(layout.labelBaseline);
    expect(placement.fontSizePt).toBeGreaterThan(0);
    expect(placement.fontSizePt).toBeLessThan(5);
    expect(placement.x + placement.width).toBeCloseTo(layout.width - mmToPt(4));
  });

  it.each(["a4", "letter"] as const)(
    "fits nine exact-size cards on %s with safe crop marks",
    (paper) => {
      const options = printSettingsSchema.parse({ paper });
      const layout = createLayout(options);
      expect(layout.slots).toHaveLength(9);
      expect(layout.slots[0]?.trim.width).toBeCloseTo(mmToPt(63));
      expect(layout.slots[0]?.trim.height).toBeCloseTo(mmToPt(88));
      for (const slot of layout.slots) {
        expect(slot.x).toBeGreaterThanOrEqual(mmToPt(options.marginMm));
        expect(slot.y + slot.height).toBeLessThanOrEqual(
          layout.height - mmToPt(options.marginMm) + 0.001,
        );
        for (const line of layout.guides) {
          for (const point of [
            { x: line.x1, y: line.y1 },
            { x: line.x2, y: line.y2 },
          ]) {
            const { trim } = slot;
            expect(
              point.x > trim.x &&
                point.x < trim.x + trim.width &&
                point.y > trim.y &&
                point.y < trim.y + trim.height,
            ).toBe(false);
          }
        }
      }
    },
  );

  it("marks every card corner, not only the sheet margins", () => {
    const layout = createLayout(printSettingsSchema.parse({}));
    expect(layout.guides).toHaveLength(48);
    const [first, , , below] = layout.slots;
    if (!first || !below) throw new Error("Missing slots");
    const tick = layout.guides.find(
      (g) =>
        g.x1 === first.trim.x &&
        g.y1 > first.trim.y + first.trim.height &&
        g.y2 < below.trim.y,
    );
    expect(tick?.y1).toBeCloseTo(
      first.trim.y + first.trim.height + mmToPt(0.5),
    );
    expect(tick?.y2).toBeCloseTo(below.trim.y - mmToPt(0.5));
    // Shared trim edges collapse to 4 lines each way: 16 outer marks, no ticks.
    expect(
      createLayout(printSettingsSchema.parse({ bleedMm: 0 })).guides,
    ).toHaveLength(16);
  });

  it("adds registration targets and a sheet label only when marks are on", () => {
    const duplex = createLayout(
      printSettingsSchema.parse({ backs: "long-edge" }),
    );
    expect(duplex.registration).toHaveLength(3);
    expect(duplex.labelBaseline).not.toBeNull();
    expect(createLayout(printSettingsSchema.parse({})).registration).toEqual(
      [],
    );
    const clean = createLayout(
      printSettingsSchema.parse({ backs: "long-edge", guides: "none" }),
    );
    expect(clean.registration).toEqual([]);
    expect(clean.labelBaseline).toBeNull();
  });

  it("rejects impossible and manually overflowing layouts instead of shrinking cards", () => {
    expect(() =>
      createLayout(
        printSettingsSchema.parse({
          paper: "custom",
          customWidthMm: 50,
          customHeightMm: 50,
        }),
      ),
    ).toThrow(/fit/i);
    expect(() =>
      createLayout(printSettingsSchema.parse({ columns: 8 })),
    ).toThrow(/fit/i);
  });

  it("mirrors duplex slots on the correct axis for portrait and landscape", () => {
    for (const orientation of ["portrait", "landscape"] as const) {
      const options = printSettingsSchema.parse({
        orientation,
        backs: "long-edge",
        backOffsetXmm: 1,
      });
      const layout = createLayout(options);
      const slot = layout.slots[0];
      if (!slot) throw new Error("Missing slot");
      const back = duplexSlot(slot, layout, options);
      expect(back.x).toBeCloseTo(
        (orientation === "portrait"
          ? layout.width - slot.x - slot.width
          : slot.x) + mmToPt(1),
      );
      expect(back.y).toBeCloseTo(
        orientation === "portrait"
          ? slot.y
          : layout.height - slot.y - slot.height,
      );
    }
  });

  it.each(["free", "scm"] as const)(
    "rotates %s back geometry about the paper centre, independent of XY offsets",
    (layoutMode) => {
      const settings = printSettingsSchema.parse({
        layoutMode,
        backs: "long-edge",
        backRotationDeg: -2.75,
        backOffsetXmm: 1.5,
        backOffsetYmm: -1,
      });
      const layout = createLayout(settings);
      expect(duplexRotation(layout, settings)).toBe(
        `rotate(-2.75 ${layout.width / 2} ${layout.height / 2})`,
      );
      expect(
        duplexRotation(layout, printSettingsSchema.parse({})),
      ).toBeUndefined();
    },
  );
});
