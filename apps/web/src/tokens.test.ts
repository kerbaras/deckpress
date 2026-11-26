import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

it("defines every CSS custom property referenced in the web source", () => {
  const root = import.meta.dirname;
  const definitions = new Set<string>();
  const references = new Map<string, Set<string>>();

  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (
      !entry.isFile() ||
      !/\.(css|html|[jt]sx?)$/.test(entry.name) ||
      /\.(test|spec)\.[jt]sx?$/.test(entry.name)
    ) {
      continue;
    }

    const path = join(entry.parentPath, entry.name);
    const source = readFileSync(path, "utf8");
    const declarations = entry.name.endsWith(".css")
      ? /(?:^|[;{])\s*(--[\w-]+)\s*:/gm
      : /\[?["'`](--[\w-]+)["'`](?:\s+as\s+string)?\]?\s*:/g;
    for (const [, name] of source.matchAll(declarations)) {
      if (name) definitions.add(name);
    }
    for (const [, name] of source.matchAll(/\bvar\(\s*(--[\w-]+)\s*[,)]/g)) {
      if (!name) continue;
      const files = references.get(name) ?? new Set<string>();
      files.add(relative(root, path));
      references.set(name, files);
    }
  }

  const undefinedReferences = [...references]
    .filter(([name]) => !definitions.has(name))
    .map(([name, files]) => `${name} in ${[...files].sort().join(", ")}`)
    .sort();
  expect(undefinedReferences).toEqual([]);
});
