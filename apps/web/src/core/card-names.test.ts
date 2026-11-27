import { expect, it } from "vitest";
import fixtures from "../../../../packages/core/tests/fixtures/card-names.json";
import { cardLookupName, splitCardAlternative } from "./card-names.ts";

it.each(fixtures)(
  "looks up '$input' and prepares its split fallback",
  (fixture) => {
    expect(cardLookupName(fixture.input)).toBe(fixture.lookup);
    expect(splitCardAlternative(fixture.input)).toBe(fixture.alternative);
  },
);
