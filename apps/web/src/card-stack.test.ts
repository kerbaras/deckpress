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

const card = ".card-stack > .playing-card";

function declarations(selector: string) {
  return rules.find((rule) => rule.selectorText === selector)?.style;
}

it("raises the full card on hover intent and keyboard focus", () => {
  const raised = declarations(`${card}.raised`);
  expect(raised?.getPropertyValue("z-index")).toBe("10");
  expect(raised?.getPropertyValue("transform")).toBe("translateY(-8px)");
});

it("paints later copy and in-strip language badges above the raised card within the stack", () => {
  const later = `${card}.raised ~ .playing-card`;
  const selectors = [
    `${later} > .quantity`,
    `${later} > .card-language[data-in-stack-strip]`,
  ];
  const badges = rules.find(
    (rule) => rule.selectorText.replace(/\s+/g, " ") === selectors.join(", "),
  );
  expect(badges?.style.getPropertyValue("z-index")).toBe("11");
  expect(declarations(".card-stack")?.getPropertyValue("isolation")).toBe(
    "isolate",
  );
});

it("leaves hit testing to the painted cards and badges", () => {
  const stackRules = rules.filter((rule) =>
    rule.selectorText.includes(".card-stack"),
  );
  expect(
    stackRules.filter(
      (rule) =>
        rule.selectorText.includes("::") ||
        rule.selectorText.includes(":hover") ||
        rule.selectorText.includes(":focus-visible") ||
        rule.style.getPropertyValue("pointer-events"),
    ),
  ).toHaveLength(0);
});
