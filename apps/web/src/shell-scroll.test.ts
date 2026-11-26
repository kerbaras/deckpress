import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

function declarations(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = css.matchAll(
    new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm"),
  );
  const result = new Map<string, string>();
  for (const [, body] of blocks)
    for (const [, name, value] of (body ?? "").matchAll(
      /([\w-]+)\s*:\s*([^;]+);/g,
    ))
      if (name && value) result.set(name, value.trim());
  return result;
}

it("keeps the document from scrolling the app shell", () => {
  const root = declarations("html,\nbody,\n#root");
  expect(root.get("height")).toBe("100%");
  expect(root.get("overflow")).toBe("hidden");
  expect(root.get("overscroll-behavior")).toBe("none");
});

it("contains absolutely positioned descendants inside their scroller", () => {
  // `.sr-only` live regions deep in a long page otherwise take the initial
  // containing block and extend the document below the window.
  expect(declarations(".app-shell").get("position")).toBe("relative");
  const page = declarations(".main-content");
  expect(page.get("position")).toBe("relative");
  expect(page.get("overflow-y")).toBe("auto");
  expect(page.get("overscroll-behavior")).toBe("contain");
});
