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
          const midpoint = {
            x: (line.x1 + line.x2) / 2,
            y: (line.y1 + line.y2) / 2,
          };
          expect(
            midpoint.x > slot.x &&
              midpoint.x < slot.x + slot.width &&
              midpoint.y > slot.y &&
              midpoint.y < slot.y + slot.height,
          ).toBe(false);
        }
      }
    },
  );

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
