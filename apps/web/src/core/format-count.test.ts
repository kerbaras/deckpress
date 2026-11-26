import { expect, it, vi } from "vitest";
import { formatCount } from "./index.ts";

it.each([
  [0, "0 cards", "0 copies"],
  [1, "1 card", "1 copy"],
  [2, "2 cards", "2 copies"],
])("formats a count of %i", (count, cards, copies) => {
  expect(formatCount(count, "card")).toBe(cards);
  expect(formatCount(count, "copy", "copies")).toBe(copies);
});

it("chooses the form from the plural category rather than the number", () => {
  const select = vi.spyOn(Intl.PluralRules.prototype, "select");
  try {
    select.mockReturnValueOnce("one").mockReturnValueOnce("few");
    expect(formatCount(2, "match", "matches")).toBe(
      `${(2).toLocaleString()} match`,
    );
    expect(formatCount(1, "match", "matches")).toBe(
      `${(1).toLocaleString()} matches`,
    );
  } finally {
    select.mockRestore();
  }
});
