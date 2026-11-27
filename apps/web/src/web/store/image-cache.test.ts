import { expect, it } from "vitest";
import { imageSrc } from "./image-cache.ts";

it("passes through Scryfall card images", () => {
  const card = "https://cards.scryfall.io/normal/front/a/b/ab.jpg?1700000000";
  expect(imageSrc(card)).toBe(card);
});

it("passes through Scryfall set icons with their cache-busting query", () => {
  const icon = "https://svgs.scryfall.io/sets/ecl.svg?1795410000";
  expect(imageSrc(icon)).toBe(icon);
  expect(imageSrc("https://svgs.scryfall.io/sets/p-30a_x.svg")).toBe(
    "https://svgs.scryfall.io/sets/p-30a_x.svg",
  );
});

it.each([
  "https://svgs.scryfall.io/card-symbols/W.svg",
  "https://svgs.scryfall.io/sets/.svg",
  "https://svgs.scryfall.io/sets/ecl.png",
  "https://svgs.scryfall.io/sets/a/b.svg",
  "https://user@svgs.scryfall.io/sets/ecl.svg",
  "http://svgs.scryfall.io/sets/ecl.svg",
  "https://svgs.scryfall.io:8443/sets/ecl.svg",
  "https://example.com/sets/ecl.svg",
  "art.png",
])("rejects %s", (source) => {
  expect(imageSrc(source)).toBeUndefined();
});
