import { z } from "zod";
import type { Art } from "../../core/index.ts";
import type { Scryfall } from "./scryfall.ts";
import { record, recordList, usableCard } from "./scryfall-card.ts";
import { anyOf, searchBatches } from "./search-batches.ts";

export interface Printing {
  id: string;
  oracleId: string;
  set: string;
  collector: string;
  date: string;
  language: string;
  frame: string;
  border: string;
  fullArt: boolean;
  showcase: boolean;
  treatments: string[];
  paper: boolean;
  promo: boolean;
  illustrations: (string | undefined)[];
  scans?: Art[];
}

const uuid = z.uuid();
const string = (value: unknown) => (typeof value === "string" ? value : "");
const illustration = (value: Record<string, unknown>) =>
  uuid.safeParse(value.illustration_id).data;

export function policyPrinting(value: unknown): Printing | undefined {
  const raw = record(value);
  const id = string(raw.id);
  if (!id) return undefined;
  const illustrations =
    raw.image_uris || !Array.isArray(raw.card_faces)
      ? [illustration(raw)]
      : recordList(raw.card_faces).map(illustration);
  const scans = usableCard(raw)?.faces;
  const effects = Array.isArray(raw.frame_effects)
    ? raw.frame_effects.filter(
        (effect): effect is string => typeof effect === "string",
      )
    : [];
  return {
    id,
    oracleId: string(raw.oracle_id) || id,
    set: string(raw.set),
    collector: string(raw.collector_number),
    date: string(raw.released_at),
    language: string(raw.lang),
    frame: string(raw.frame),
    border: string(raw.border_color),
    fullArt: raw.full_art === true,
    showcase: effects.includes("showcase"),
    treatments: [
      ...effects.filter((effect) => effect !== "showcase"),
      ...(raw.textless === true ? ["textless"] : []),
    ],
    paper:
      raw.digital !== true &&
      Array.isArray(raw.games) &&
      raw.games.includes("paper"),
    promo: raw.promo === true,
    illustrations,
    ...(scans?.length === illustrations.length ? { scans } : {}),
  };
}

// Bound the length of Scryfall search URLs even with a family/language filter.
const oracleBatchSize = 18;
const collectionBatchSize = 75;

export function policyProvider(api: Scryfall) {
  async function inventoryBatch(
    oracleIds: string[],
    language?: string,
    sets?: string[],
    onProgress?: (done: number, total: number) => void,
  ) {
    const ids = [
      ...new Set(oracleIds.filter((id) => uuid.safeParse(id).success)),
    ].sort();
    const prints = new Map<string, Printing[]>(ids.map((id) => [id, []]));
    const setTerms = sets?.map((set) => `set:${set}`);
    const filters = ["game:paper"];
    if (setTerms?.length) filters.push(anyOf(setTerms));
    if (language) filters.push(`lang:${language}`);
    const complete = await searchBatches(
      api,
      ids.map((id) => `oracleid:${id}`),
      filters,
      (cards) => {
        for (const raw of cards) {
          const print = policyPrinting(raw);
          if (print && (!language || print.language === language))
            prints.get(print.oracleId)?.push(print);
        }
        return false;
      },
      oracleBatchSize,
      onProgress,
    );
    if (!complete)
      throw new Error(
        "Scryfall has too many printings to evaluate this art policy.",
      );
    return prints;
  }

  return {
    sets: () => api.sets(),
    inventoryBatch,
    async anchors(ids: string[]) {
      const ordered = [
        ...new Set(ids.filter((id) => uuid.safeParse(id).success)),
      ].sort();
      const prints = new Map<string, Printing>();
      for (
        let start = 0;
        start < ordered.length;
        start += collectionBatchSize
      ) {
        const batch = ordered.slice(start, start + collectionBatchSize);
        for (const raw of await api.collection(batch.map((id) => ({ id })))) {
          const print = policyPrinting(raw);
          if (print && batch.includes(print.id)) prints.set(print.id, print);
        }
      }
      return prints;
    },
    async get(artId: string) {
      const id = artId.startsWith("scryfall:")
        ? artId.split(":")[1]
        : undefined;
      if (!id || !uuid.safeParse(id).success) return undefined;
      const print = policyPrinting(await api.printing(id));
      return print?.id === id ? print : undefined;
    },
    async exact(anchor: Printing, lang: string) {
      const print = policyPrinting(
        await api.exact(anchor.set, anchor.collector, lang),
      );
      return print?.set === anchor.set && print.collector === anchor.collector
        ? print
        : undefined;
    },
    async inventory(oracleId: string, language?: string) {
      return (await inventoryBatch([oracleId], language)).get(oracleId) ?? [];
    },
  };
}
