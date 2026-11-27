import { z } from "zod";
import type {
  ArtPreviewProgress,
  PrintLanguagePreferences,
} from "../../api.ts";
import { artChangeSchema } from "../../core/art-preview.ts";
import { type Deck, type DeckEntry, entrySchema } from "../../core/index.ts";
import { webAssetBase } from "../asset-base.ts";
import { loadCoreWasm } from "../core-wasm.ts";
import type { Printing, policyProvider } from "../providers/printings.ts";

const lookupsSchema = z.object({
  anchorIds: z.array(z.string()),
  oracleIds: z.array(z.string()),
});
const fallbackSchema = z.object({ englishOracleIds: z.array(z.string()) });
const updateSchema = entrySchema
  .pick({
    id: true,
    policyArt: true,
    languageAnchor: true,
    languageChoices: true,
    requestedLanguages: true,
  })
  .extend({ languageAnchor: entrySchema.shape.languageAnchor.nullable() })
  .transform((update) => ({
    ...update,
    languageAnchor: update.languageAnchor ?? undefined,
  }));
const planSchema = z.object({
  changes: z.array(artChangeSchema),
  updates: z.array(updateSchema),
});
const overrideSchema = z.object({
  update: updateSchema,
  change: artChangeSchema,
});

export async function planDeckLanguage(
  provider: ReturnType<typeof policyProvider>,
  deck: Deck,
  language: string,
  preferences: PrintLanguagePreferences,
  onProgress?: (progress: ArtPreviewProgress) => void,
) {
  const wasm = await loadCoreWasm(webAssetBase());
  const deckJson = JSON.stringify(deck);
  const { anchorIds, oracleIds } = lookupsSchema.parse(
    JSON.parse(wasm.deckLanguageLookups(deckJson, language)),
  );
  async function inventory(ids: string[], language: string) {
    return Object.fromEntries(
      await provider.inventoryBatch(ids, language, undefined, (done, total) =>
        onProgress?.({ kind: "printings", language, done, total }),
      ),
    );
  }
  const [sets, anchors, candidates] = oracleIds.length
    ? await Promise.all([
        provider.sets(),
        provider.anchors(anchorIds),
        inventory(oracleIds, language),
      ])
    : [[], [], {}];
  const args = [
    deckJson,
    language,
    JSON.stringify(preferences.policy),
    JSON.stringify({ sets, anchors: Object.fromEntries(anchors), candidates }),
  ] as const;
  let proposal: unknown = JSON.parse(wasm.planDeckLanguage(...args));
  const fallback = fallbackSchema.safeParse(proposal);
  if (fallback.success) {
    const english = await inventory(fallback.data.englishOracleIds, "en");
    proposal = JSON.parse(
      wasm.planDeckLanguage(...args, JSON.stringify(english)),
    );
  }
  const { changes, updates } = planSchema.parse(proposal);
  const byId = new Map(updates.map((update) => [update.id, update]));
  const next =
    updates.length || deck.printLanguage !== language
      ? {
          ...deck,
          printLanguage: language,
          entries: deck.entries.map((entry) => {
            const update = byId.get(entry.id);
            return update ? { ...entry, ...update } : entry;
          }),
        }
      : null;
  return { changes, next };
}

export async function languageOverride(
  original: DeckEntry,
  proposed: DeckEntry,
  printing: Printing | undefined,
  language: string,
) {
  const wasm = await loadCoreWasm(webAssetBase());
  const { update, change } = overrideSchema.parse(
    JSON.parse(
      wasm.overrideDeckLanguagePrint(
        JSON.stringify(original),
        JSON.stringify(proposed),
        JSON.stringify(printing ?? null),
        language,
      ),
    ),
  );
  return { entry: { ...proposed, ...update }, change };
}
