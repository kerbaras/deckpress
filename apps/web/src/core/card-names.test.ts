import { expect, it } from "vitest";
import fixtures from "../../../../packages/core/tests/fixtures/card-names.json";
import {
  ampersandCardAlternative,
  canonicalCardName,
  cardLookupName,
} from "./card-names.ts";

it.each(fixtures)("normalizes '$input' for collection lookup", (fixture) => {
  const canonical = canonicalCardName(fixture.input);
  expect(canonical).toBe(fixture.canonical);
  expect(cardLookupName(canonical)).toBe(fixture.lookup);
  expect(ampersandCardAlternative(canonical)).toBe(fixture.alternative);
});
