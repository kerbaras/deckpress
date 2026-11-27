import {
  type Art,
  backArt,
  createLayout,
  type Deck,
  effectivePrintSettings,
  frontArt,
  type PrintSettings,
  printableEntries,
  printPageCount,
} from "../../core/index.ts";

export function exportPlan(deck: Deck, settings: PrintSettings) {
  const { slots } = createLayout(settings);
  const effective = effectivePrintSettings(settings);
  const cards = printableEntries(deck, settings).flatMap((entry) =>
    Array.from({ length: entry.quantity }, () => entry),
  );
  if (!cards.length) throw new Error("No cards are included in this print job");
  const totalSheets = Math.ceil(cards.length / slots.length);
  const first = settings.pageFrom - 1;
  const last = Math.min(settings.pageTo || totalSheets, totalSheets);
  if (first >= last) throw new Error("Page range is outside the deck");

  const sources = new Map<
    string,
    { art: Art; name: string; entryId: string; back: boolean }
  >();
  let faces = 0;
  for (const entry of cards.slice(first * slots.length, last * slots.length)) {
    const front = frontArt(entry);
    const back = effective.backs === "none" ? null : backArt(entry);
    for (const [art, isBack] of [
      [front, false],
      [back, true],
    ] as const) {
      if (!art) continue;
      faces++;
      if (!sources.has(art.imageUrl)) {
        sources.set(art.imageUrl, {
          art,
          name: entry.card.name,
          entryId: entry.id,
          back: isBack,
        });
      }
    }
  }
  return { sources, faces, ...printPageCount(last - first, effective) };
}
