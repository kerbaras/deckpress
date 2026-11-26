import { expect, it } from "vitest";
import fixture from "../../../../packages/core/assets/scm/trim-rects.json";
import { createLayout } from "./layout.ts";
import { printSettingsSchema } from "./models.ts";

it("matches SCM trim rectangles within 0.01 mm with the template grids", () => {
  expect(fixture.layouts).toHaveLength(114);
  for (const expected of fixture.layouts) {
    const first = expected.trimRects[0];
    if (!first) throw new Error(`${expected.id}: missing trim rectangles`);
    const layout = createLayout(
      printSettingsSchema.parse({
        paper: "custom",
        customWidthMm: expected.paperMm[0],
        customHeightMm: expected.paperMm[1],
        orientation: expected.orientation,
        cardWidthMm: first.exactMm[2],
        cardHeightMm: first.exactMm[3],
        marginMm: expected.insetMm,
        gapMm: fixture.gapMm,
        bleedMm: 0,
        guides: "none",
        columns: expected.columns,
        rows: expected.rows,
      }),
    );
    expect(layout.slots, expected.id).toHaveLength(expected.trimRects.length);
    expected.trimRects.forEach(({ exactMm }, index) => {
      const slot = layout.slots[index];
      if (!slot) throw new Error(`${expected.id}: missing slot ${index}`);
      const { x, y, width, height } = slot.trim;
      [x, y, width, height].forEach((pt, field) => {
        expect(
          Math.abs((pt * 25.4) / 72 - (exactMm[field] ?? Number.NaN)),
          `${expected.id} slot ${index} coordinate ${field}`,
        ).toBeLessThanOrEqual(0.01);
      });
    });
  }
});

it("matches pixel-rounded SCM mode on all 114 default templates", () => {
  expect(fixture.layouts).toHaveLength(114);
  for (const expected of fixture.layouts) {
    const layout = createLayout(
      printSettingsSchema.parse({
        layoutMode: "scm",
        scmTemplate: {
          paper: expected.paper,
          card: expected.card,
          variant: "default",
          marks: 3,
        },
      }),
    );
    expect([layout.columns, layout.rows], expected.id).toEqual([
      expected.columns,
      expected.rows,
    ]);
    expect(layout.guides, expected.id).toHaveLength(0);
    const armWidth = layout.registrationInk[1]?.width ?? 0;
    expect((armWidth * 25.4) / 72 - 0.5, expected.id).toBeCloseTo(
      Math.min(20, Math.max(5, expected.drawnArmMm)),
      8,
    );
    expect(layout.slots, expected.id).toHaveLength(expected.trimRects.length);
    expected.trimRects.forEach(({ scmMm }, index) => {
      const slot = layout.slots[index];
      if (!slot) throw new Error(`${expected.id}: missing slot ${index}`);
      const { x, y, width, height } = slot.trim;
      [x, y, width, height].forEach((pt, field) => {
        expect(
          Math.abs((pt * 25.4) / 72 - (scmMm[field] ?? Number.NaN)),
          `${expected.id} slot ${index} coordinate ${field}`,
        ).toBeLessThanOrEqual(0.02);
      });
    });
  }
});
