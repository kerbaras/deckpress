import { z } from "zod";
import type { Art, ArtPolicy } from "../../core/index.ts";
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
    showcase:
      Array.isArray(raw.frame_effects) &&
      raw.frame_effects.includes("showcase"),
    paper:
      raw.digital !== true &&
      Array.isArray(raw.games) &&
      raw.games.includes("paper"),
    promo: raw.promo === true,
    illustrations,
    ...(scans?.length === illustrations.length ? { scans } : {}),
  };
}

export function permits(
  policy: ArtPolicy,
  print: Printing,
  ranks?: ReadonlyMap<string, number>,
) {
  if (!print.paper || print.promo) return false;
  switch (policy.kind) {
    case "matchSet":
      return ranks ? ranks.has(print.set) : print.set === policy.set;
    case "style":
      return (
        (policy.frame === null || print.frame === policy.frame) &&
        (policy.border === null || print.border === policy.border)
      );
    default:
      return true;
  }
}

function treatmentMatches(policy: ArtPolicy, print: Printing) {
  switch (policy.kind === "style" ? policy.treatment : null) {
    case "none":
      return !print.fullArt && !print.showcase;
    case "fullArt":
      return print.fullArt;
    case "showcase":
      return print.showcase;
    default:
      return true;
  }
}

const quality = { missing: 1, placeholder: 2, lowres: 3, highres_scan: 4 };
function scanQuality(print: Printing) {
  const scan = print.scans?.[0]?.scanQuality;
  return scan ? quality[scan] : 0;
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function comparePrints(
  policy: ArtPolicy,
  a: Printing,
  b: Printing,
  deckPolicy: boolean,
  ranks?: ReadonlyMap<string, number>,
) {
  return (
    (ranks ? (ranks.get(a.set) ?? 0) - (ranks.get(b.set) ?? 0) : 0) ||
    Number(treatmentMatches(policy, b)) - Number(treatmentMatches(policy, a)) ||
    Number(!a.date) - Number(!b.date) ||
    (policy.kind === "original"
      ? order(a.date, b.date)
      : order(b.date, a.date)) ||
    (deckPolicy ? scanQuality(b) - scanQuality(a) : 0) ||
    order(a.set, b.set) ||
    order(a.collector, b.collector) ||
    Number(a.language !== "en") - Number(b.language !== "en") ||
    order(a.id, b.id)
  );
}

export function samePrintingNumber(a: Printing, b: Printing) {
  return a.set === b.set && a.collector === b.collector;
}

function sameIllustrations(anchor: Printing, candidate: Printing) {
  return (
    anchor.oracleId === candidate.oracleId &&
    (anchor.id === candidate.id ||
      (anchor.illustrations.length > 0 &&
        anchor.illustrations.length === candidate.illustrations.length &&
        anchor.illustrations.every(
          (id, i) => id !== undefined && id === candidate.illustrations[i],
        )))
  );
}

export function localized(
  anchor: Printing,
  options: Printing[],
  language: string,
  policy?: ArtPolicy,
  ranks?: ReadonlyMap<string, number>,
) {
  return options
    .filter(
      (print) =>
        print.paper &&
        print.language === language &&
        print.scans &&
        sameIllustrations(anchor, print) &&
        (!policy ||
          (permits(policy, print, ranks) &&
            (!treatmentMatches(policy, anchor) ||
              treatmentMatches(policy, print)))),
    )
    .sort(
      (a, b) =>
        Number(samePrintingNumber(anchor, b)) -
          Number(samePrintingNumber(anchor, a)) ||
        comparePrints(
          policy ?? { kind: "latest" },
          a,
          b,
          policy !== undefined,
          ranks,
        ),
    )[0];
}

// Bound the length of Scryfall search URLs even with a family/language filter.
const oracleBatchSize = 18;

export function policyProvider(api: Scryfall) {
  async function inventoryBatch(
    oracleIds: string[],
    language?: string,
    sets?: string[],
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
      return print && samePrintingNumber(anchor, print) ? print : undefined;
    },
    async inventory(oracleId: string, language?: string) {
      return (await inventoryBatch([oracleId], language)).get(oracleId) ?? [];
    },
  };
}
