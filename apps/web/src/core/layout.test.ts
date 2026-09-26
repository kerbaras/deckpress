import { describe, expect, it } from "vitest";
import { createLayout, duplexSlot, mmToPt } from "./layout.ts";
import { printSettingsSchema } from "./models.ts";

describe("print geometry", () => {
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
});
