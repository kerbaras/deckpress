import { z } from "zod";
import { type Deck, type DeckEntry, isArtPinned } from "../../core/index.ts";
import { type SetInfo, setCoverageSchema } from "../../core/sets.ts";
import { webAssetBase } from "../asset-base.ts";
import { loadCoreWasm } from "../core-wasm.ts";
import type { policyProvider } from "../providers/printings.ts";

export function canChangeArt(entry: DeckEntry) {
  return (
    !isArtPinned(entry) &&
    entry.card.faces.every((art) => art.provider === "scryfall")
  );
}

export async function setFamilyRanks(chosen: string, sets: SetInfo[]) {
  const wasm = await loadCoreWasm(webAssetBase());
  const rows = z
    .array(z.tuple([z.string(), z.number()]))
    .parse(JSON.parse(wasm.setFamily(chosen, JSON.stringify(sets))));
  return new Map(rows);
}

export async function setCoverage(
  provider: ReturnType<typeof policyProvider>,
  deck: Deck,
) {
  const eligible = deck.entries.filter(canChangeArt);
  if (!eligible.length) return [];
  const [wasm, sets, inventory] = await Promise.all([
    loadCoreWasm(webAssetBase()),
    provider.sets(),
    provider.inventoryBatch(eligible.map(({ card }) => card.oracleId)),
  ]);
  const entries = deck.entries.map((entry) => {
    const { card, quantity } = entry;
    if (!canChangeArt(entry)) return [quantity, []];
    const sets = (inventory.get(card.oracleId) ?? [])
      .filter(
        (print) =>
          print.paper &&
          !print.promo &&
          print.illustrations.length === card.faces.length,
      )
      .map(({ set }) => set);
    return [quantity, sets];
  });
  return z
    .array(setCoverageSchema)
    .parse(
      JSON.parse(
        wasm.setCoverage(JSON.stringify(entries), JSON.stringify(sets)),
      ),
    );
}
