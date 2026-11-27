import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const sheet = new CSSStyleSheet();
sheet.replaceSync(
  readFileSync(join(import.meta.dirname, "styles.css"), "utf8"),
);
const rules = Array.from(sheet.cssRules).filter(
  (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule,
);

it.each([":hover", ":focus-visible"])(
  "keeps later card strips above an overlapping stack card in %s",
  (state) => {
    const selector = `.card-stack > .playing-card${state}`;
    const cardRules = rules.filter((rule) =>
      rule.selectorText.split(",").some((part) => part.trim() === selector),
    );

    expect(cardRules).not.toHaveLength(0);
    for (const rule of cardRules) {
      expect(["", "auto"]).toContain(rule.style.getPropertyValue("z-index"));
    }
  },
);
