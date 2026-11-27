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
const nonLastCard = `${card}:not(:last-child)`;

function declarations(selector: string) {
  return rules.find((rule) => rule.selectorText === selector)?.style;
}

it("raises the full card on hover and keyboard focus", () => {
  const raised = declarations(`${card}:hover,\n${card}:focus-visible`);
  expect(raised?.getPropertyValue("z-index")).toBe("10");
  expect(raised?.getPropertyValue("transform")).toBe("translateY(-8px)");
});

it("lets hits pass through raised non-final cards except for their own strips", () => {
  const raised = declarations(`${nonLastCard}:is(:hover, :focus-visible)`);
  expect(raised?.getPropertyValue("pointer-events")).toBe("none");

  const strip = declarations(`${nonLastCard}::after`);
  expect(strip?.getPropertyValue("content")).toBe('""');
  expect(strip?.getPropertyValue("position")).toBe("absolute");
  expect(strip?.getPropertyValue("inset")).toBe("0 0 auto");
  expect(strip?.getPropertyValue("pointer-events")).toBe("auto");
  expect(strip?.getPropertyValue("height")).toBe(
    "calc(var(--card-stack-step) + 8px)",
  );
  const stack = declarations(".card-stack");
  expect(stack?.getPropertyValue("grid-auto-rows")).toBe(
    "var(--card-stack-step)",
  );
  expect(stack?.getPropertyValue("--card-stack-step")).toBe("43px");
});

it("keeps the raised card's copy, language, and print-status badges clickable", () => {
  const selector = `${nonLastCard}:is(:hover, :focus-visible) > :is(.quantity, .card-language, .card-status, button)`;
  const controls = rules.find(
    (rule) => rule.selectorText.replace(/\s+/g, " ") === selector,
  );
  expect(controls?.style.getPropertyValue("pointer-events")).toBe("auto");
});

it("bridges the raised strip to the print-status badge without covering the whole card", () => {
  const selector = `${nonLastCard}:is(:hover, :focus-visible):has(> .card-status)::before`;
  const bridge = rules.find(
    (rule) =>
      rule.selectorText.replace(/\s+/g, "") === selector.replace(/\s+/g, ""),
  )?.style;
  expect(bridge?.getPropertyValue("content")).toBe('""');
  expect(bridge?.getPropertyValue("position")).toBe("absolute");
  expect(bridge?.getPropertyValue("inset")).toBe("0 auto 8px 30px");
  expect(bridge?.getPropertyValue("width")).toBe("26px");
  expect(bridge?.getPropertyValue("pointer-events")).toBe("auto");
});
