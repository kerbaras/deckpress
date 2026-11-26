import { expect, it } from "vitest";
import fixture from "../../../../packages/core/assets/scm/trim-rects.json";
import { createLayout, duplexSlot } from "./layout.ts";
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

it("matches every default template at SCM's whole-pixel trim positions", () => {
  expect(fixture.layouts).toHaveLength(114);
  for (const expected of fixture.layouts) {
    const { paper, card, id } = expected;
    const layout = createLayout(
      printSettingsSchema.parse({
        layoutMode: "scm",
        scmTemplate: { paper, card, variant: "default", marks: 3 },
        bleedMm: 5,
      }),
    );
    expect([layout.columns, layout.rows], id).toEqual([
      expected.columns,
      expected.rows,
    ]);
    expect(layout.slots, id).toHaveLength(expected.trimRects.length);
    expect(layout.guides, id).toHaveLength(0);
    expect(layout.registration, id).toHaveLength(0);
    for (const [index, { scmMm }] of expected.trimRects.entries()) {
      const slot = layout.slots[index];
      if (!slot) throw new Error(`${id}: missing slot ${index}`);
      const { x, y, width, height } = slot.trim;
      [x, y, width, height].forEach((pt, field) => {
        expect(
          Math.abs((pt * 25.4) / 72 - (scmMm[field] ?? Number.NaN)),
          id,
        ).toBeLessThanOrEqual(0.02);
      });
      expect(((x - slot.x) * 25.4) / 72, id).toBeCloseTo(0.625, 9);
    }
  }
});

it.each([
  ["a4", 297, 210, 9.4, 5],
  ["letter", 279.4, 215.9, 8.04, 6],
] as const)(
  "places the %s square and L marks in SCM's corners",
  (paper, width, height, arm, version) => {
    for (const marks of [3, 4] as const) {
      const layout = createLayout(
        printSettingsSchema.parse({
          layoutMode: "scm",
          scmTemplate: { paper, card: "standard", variant: "default", marks },
        }),
      );
      expect(layout.scm?.name).toBe(`${paper}-standard-v${version}`);
      const expected = [
        [width - 10 - arm, 9.5, arm + 0.5, 1],
        [width - 10.5, 9.5, 1, arm + 0.5],
        [9.5, height - 10.5, arm + 0.5, 1],
        [9.5, height - 10 - arm, 1, arm + 0.5],
      ];
      if (marks === 3) expected.unshift([9.5, 9.5, 6, 6]);
      else {
        expected.unshift([9.5, 9.5, arm + 0.5, 1], [9.5, 9.5, 1, arm + 0.5]);
        expected.push(
          [width - 10 - arm, height - 10.5, arm + 0.5, 1],
          [width - 10.5, height - 10 - arm, 1, arm + 0.5],
        );
      }
      expect(layout.scm?.marks).toHaveLength(expected.length);
      for (const [index, { x, y, width, height }] of (
        layout.scm?.marks ?? []
      ).entries()) {
        [x, y, width, height].forEach((pt, field) => {
          expect(
            Math.abs(
              (pt * 25.4) / 72 - (expected[index]?.[field] ?? Number.NaN),
            ),
          ).toBeLessThanOrEqual(0.1);
        });
      }
    }
  },
);

it.each(["default", "borderless"] as const)(
  "duplexes %s templates onto their original slots",
  (variant) => {
    const settings = printSettingsSchema.parse({
      layoutMode: "scm",
      scmTemplate: { paper: "a4", card: "standard", variant, marks: 3 },
      backs: "short-edge",
    });
    const layout = createLayout(settings);
    const slot = layout.slots[0];
    const opposite =
      layout.slots[
        variant === "default"
          ? (layout.rows - 1) * layout.columns
          : layout.columns - 1
      ];
    if (!slot || !opposite) throw new Error("missing template slot");
    const mirror = duplexSlot(slot, layout, settings);
    expect(mirror.trim.x).toBeCloseTo(opposite.trim.x, 9);
    expect(mirror.trim.y).toBeCloseTo(opposite.trim.y, 9);
  },
);
