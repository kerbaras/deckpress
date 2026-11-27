import { z } from "zod";
import type { PrintLanguagePreferences } from "../../api.ts";
import { artChangeSchema } from "../../core/art-preview.ts";
import { type ArtPolicy, type Deck, entrySchema } from "../../core/index.ts";
import { webAssetBase } from "../asset-base.ts";
import { loadCoreWasm } from "../core-wasm.ts";
import type { Printing, policyProvider } from "../providers/printings.ts";
import { canChangeArt, setFamilyRanks } from "./set-matching.ts";

export function validatePolicy(policy: ArtPolicy) {
  if (policy.kind === "matchSet" && !/^[a-z0-9]{1,20}$/.test(policy.set)) {
    throw new Error("Enter a valid set code.");
  }
  if (
    policy.kind === "style" &&
    policy.frame === null &&
    policy.border === null &&
    policy.treatment === null
  ) {
    throw new Error("Choose a frame, border, or treatment.");
  }
}

function jsonEquals(a: unknown, b: unknown) {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : item,
    );
  return canonical(a) === canonical(b);
}

const planSchema = z.object({
  changes: z.array(artChangeSchema),
  updates: z.array(
    entrySchema
      .pick({ id: true, policyArt: true, requestedLanguages: true })
      .extend({ languageAnchor: z.null() })
      .transform((update) => ({ ...update, languageAnchor: undefined })),
  ),
});
const localizationSchema = z.object({
  change: artChangeSchema,
  update: entrySchema
    .pick({
      selectedArt: true,
      selectedBack: true,
      artPinned: true,
      requestedLanguages: true,
    })
    .nullable(),
});

export async function planPolicy(
  provider: ReturnType<typeof policyProvider>,
  deck: Deck,
  policy: ArtPolicy,
  preferences: PrintLanguagePreferences,
) {
  const oracleIds = deck.entries
    .filter(canChangeArt)
    .map(({ card }) => card.oracleId);
  const ranks =
    policy.kind === "matchSet" && policy.family && oracleIds.length
      ? await setFamilyRanks(policy.set, await provider.sets())
      : undefined;
  const setFilter =
    policy.kind === "matchSet"
      ? ranks
        ? [...ranks.keys()]
        : [policy.set]
      : undefined;
  // Search includes multilingual printings, so collect the set inventory once.
  const [wasm, inventory] = await Promise.all([
    loadCoreWasm(webAssetBase()),
    provider.inventoryBatch(oracleIds, undefined, setFilter),
  ]);
  const { changes, updates } = planSchema.parse(
    JSON.parse(
      wasm.planDeckArtPolicy(
        JSON.stringify(deck),
        JSON.stringify(policy),
        JSON.stringify(preferences),
        JSON.stringify(ranks ? Object.fromEntries(ranks) : null),
        JSON.stringify(Object.fromEntries(inventory)),
      ),
    ),
  );
  const byId = new Map(updates.map((update) => [update.id, update]));
  return {
    changes,
    next:
      updates.length || !jsonEquals(deck.artPolicy, policy)
        ? {
            ...deck,
            artPolicy: policy,
            entries: deck.entries.map((entry) => {
              const update = byId.get(entry.id);
              return update ? { ...entry, ...update } : entry;
            }),
          }
        : null,
  };
}

export async function planLocalization(
  provider: ReturnType<typeof policyProvider>,
  deck: Deck,
  entryId: string,
  artId: string,
  preferences: PrintLanguagePreferences,
) {
  const entry = deck.entries.find((entry) => entry.id === entryId);
  if (!entry) throw new Error("Card not found");
  const [wasm, anchor] = await Promise.all([
    loadCoreWasm(webAssetBase()),
    provider.get(artId),
  ]);
  const preferred = deck.printLanguage
    ? [deck.printLanguage]
    : preferences.languages;
  const languages =
    preferences.policy === "fallback-to-english" && !preferred.includes("en")
      ? [...preferred, "en"]
      : preferred;
  const entryJson = JSON.stringify(entry);
  const anchorJson = JSON.stringify(anchor ?? null);
  const preferredJson = JSON.stringify(preferred);
  function plan(candidates: Printing[], language?: string) {
    return localizationSchema.parse(
      JSON.parse(
        wasm.planPrintLocalization(
          entryJson,
          anchorJson,
          JSON.stringify(candidates),
          preferredJson,
          language,
        ),
      ),
    );
  }
  function proposal({ change, update }: z.infer<typeof localizationSchema>) {
    return {
      changes: [change],
      next: update
        ? {
            ...deck,
            entries: deck.entries.map((item) =>
              item === entry ? { ...item, ...update } : item,
            ),
          }
        : null,
    };
  }
  if (
    anchor?.oracleId === entry.card.oracleId &&
    anchor.illustrations.length === entry.card.faces.length
  ) {
    for (const language of languages) {
      const original = plan([anchor], language);
      if (original.change.kind !== "unmatched") return proposal(original);
      const exact = await provider.exact(anchor, language);
      if (exact) {
        const result = plan([exact], language);
        if (result.change.kind !== "unmatched") return proposal(result);
      }
      const inventory = plan(
        await provider.inventory(anchor.oracleId, language),
        language,
      );
      if (inventory.change.kind !== "unmatched") return proposal(inventory);
    }
  }
  return proposal(plan([]));
}
