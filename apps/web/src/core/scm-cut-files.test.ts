import { expect, it } from "vitest";
import cutTemplates from "../../../../packages/core/assets/scm/cutting-templates.json";
import source from "../../../../packages/core/assets/scm/layouts.json";
import { createLayout } from "./layout.ts";
import { printSettingsSchema } from "./models.ts";
import { scmCards, scmCutFile, scmHasDxfFallback, scmPapers } from "./scm.ts";

const vendored = new Set(Object.keys(cutTemplates.exports));
const variants = (paper: string, card: string) =>
  Object.keys(
    (source.layouts as Record<string, Record<string, object>>)[paper]?.[card] ??
      {},
  ) as ("default" | "borderless")[];

it("shows only cut files that exist in SCM's cutting_templates", () => {
  expect(cutTemplates.commit).toMatch(/^0da09b7/);
  const missing: string[] = [];
  let shown = 0;
  for (const paper of scmPapers) {
    for (const card of scmCards(paper)) {
      for (const variant of variants(paper, card)) {
        const { scm } = createLayout(
          printSettingsSchema.parse({
            layoutMode: "scm",
            scmTemplate: { paper, card, variant, marks: 3 },
          }),
        );
        if (!scm) throw new Error(`${paper}-${card}-${variant}: no template`);
        const file = scmCutFile(scm.name);
        if (file) {
          expect(vendored.has(file), file).toBe(true);
          expect(scmHasDxfFallback(scm.name), scm.name).toBe(false);
          shown += 1;
        } else {
          missing.push(scm.name);
        }
      }
    }
  }
  expect(shown).toBe(190);
  expect(missing).toHaveLength(38);
  expect([...missing].sort()).toEqual(cutTemplates.exceptions);
  for (const name of missing) {
    expect(name).toMatch(/^(a3|arch_b)-[a-z0-9_]+-borderless-v\d+$/);
    expect(scmHasDxfFallback(name), name).toBe(true);
  }
});
