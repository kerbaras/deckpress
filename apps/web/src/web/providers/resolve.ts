import type { PrintLanguagePreferences, ResolvedCards } from "../../api.ts";
import {
  ampersandCardAlternative,
  canonicalCardName,
  cardLookupName,
} from "../../core/card-names.ts";
import type { Card, DeckEntry, ImportLine } from "../../core/index.ts";
import type { Scryfall } from "./scryfall.ts";
import {
  foldName,
  nameMatches,
  printNumber,
  recordList,
  usableCard,
} from "./scryfall-card.ts";

const collectionBatch = 75;

type NumberedPrint = NonNullable<ReturnType<typeof printNumber>>;

function identifier(line: ImportLine) {
  if (line.set && line.collectorNumber) {
    return { set: line.set, collector_number: line.collectorNumber };
  }
  const name = cardLookupName(line.name);
  return line.set ? { name, set: line.set } : { name };
}

function matchesLine(
  raw: Record<string, unknown>,
  line: ImportLine,
  wanted: string,
) {
  const number = printNumber(raw);
  if (!number || (line.set && number.set !== line.set)) return false;
  if (line.collectorNumber)
    return number.collectorNumber === line.collectorNumber;
  return (
    nameMatches(raw, wanted) ||
    recordList(raw.card_faces).some((face) => nameMatches(face, wanted))
  );
}

function importLabel({ name, quantity, set, collectorNumber }: ImportLine) {
  return set
    ? `${quantity} ${name} (${set}) ${collectorNumber}`.trimEnd()
    : `${quantity} ${name}`;
}

function findCandidate(
  cards: { raw: Record<string, unknown>; card: Card | undefined }[],
  line: ImportLine,
) {
  const wanted = foldName(line.name);
  const candidates = cards.filter(({ raw }) => matchesLine(raw, line, wanted));
  return candidates.find(({ card }) => card !== undefined) ?? candidates[0];
}

export function resolvedEntry(
  id: string,
  card: Card,
  line: Pick<ImportLine, "quantity" | "zone" | "board">,
  languages: string[] = [],
): DeckEntry {
  return {
    id,
    card,
    quantity: line.quantity,
    zone: line.zone,
    ...(line.board === undefined ? {} : { board: line.board }),
    selectedArt: null,
    selectedBack: null,
    excluded: false,
    ...(languages.length ? { requestedLanguages: [...languages] } : {}),
  };
}

async function localizedPrint(
  api: Scryfall,
  line: ImportLine,
  original: Card | undefined,
  lang: string,
  checked: { number: NumberedPrint | undefined },
) {
  if (original?.faces[0]?.language === lang) return original;
  const matchesOracle = (raw: Record<string, unknown>) =>
    !original || (raw.oracle_id ?? raw.id) === original.oracleId;

  if (line.set && line.collectorNumber) {
    const raw = await api.exact(line.set, line.collectorNumber, lang);
    const number = printNumber(raw);
    if (
      number?.set === line.set &&
      number.collectorNumber === line.collectorNumber &&
      raw.lang === lang &&
      matchesOracle(raw)
    ) {
      checked.number ??= number;
      return usableCard(raw);
    }
    return undefined;
  }

  const escaped = line.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  let query = original ? `oracleid:${original.oracleId}` : `!"${escaped}"`;
  if (!original && line.set) {
    if (!/^[a-z\d]+$/i.test(line.set)) return undefined;
    query += ` set:${line.set}`;
  }
  const wanted = foldName(line.name);
  for (let page = 1; page <= 100; page++) {
    const result = await api.search(`${query} game:paper lang:${lang}`, page);
    for (const raw of result.cards) {
      const number = printNumber(raw);
      if (!number || raw.lang !== lang) continue;
      const matches = original
        ? matchesOracle(raw)
        : (!line.set || number.set === line.set) && nameMatches(raw, wanted);
      if (!matches) continue;
      checked.number ??= number;
      const card = usableCard(raw);
      if (card) return card;
    }
    if (!result.hasMore) break;
  }
  return undefined;
}

export async function resolveCards(
  api: Scryfall,
  lines: ImportLine[],
  preferences: PrintLanguagePreferences,
  newId = () => crypto.randomUUID(),
): Promise<ResolvedCards> {
  if (lines.length > 1000)
    throw new Error("Decklists are limited to 1000 lines");
  const { languages, policy } = preferences;
  const englishOnly = languages.length === 1 && languages[0] === "en";
  const fallback =
    policy === "fallback-to-english" && !languages.includes("en");
  const attempted = fallback ? [...languages, "en"] : languages;
  const entries: ResolvedCards["entries"] = [];
  const issues: ResolvedCards["issues"] = [];
  const missingPrints: NonNullable<ResolvedCards["missingPrints"]> = [];

  for (let offset = 0; offset < lines.length; offset += collectionBatch) {
    const batch = lines
      .slice(offset, offset + collectionBatch)
      .map((line) => ({ ...line, name: canonicalCardName(line.name) }));
    const collection = await api.collection(batch.map(identifier));
    const cards = collection.map((raw) => ({ raw, card: usableCard(raw) }));
    for (const [index, originalLine] of batch.entries()) {
      let line = originalLine;
      let candidate = findCandidate(cards, line);
      if (!candidate && !(line.set && line.collectorNumber)) {
        const name = ampersandCardAlternative(line.name);
        if (name) {
          const alternative = { ...line, name };
          const retry = await api.collection([identifier(alternative)]);
          candidate = findCandidate(
            retry.map((raw) => ({ raw, card: usableCard(raw) })),
            alternative,
          );
          if (candidate) line = alternative;
        }
      }
      const original = candidate?.card;
      const checked = { number: candidate && printNumber(candidate.raw) };
      let card: Card | undefined;
      if (englishOnly && !original) {
        card = undefined;
      } else {
        for (const lang of attempted) {
          card = await localizedPrint(api, line, original, lang, checked);
          if (card) break;
        }
      }

      if (card) {
        entries.push(
          resolvedEntry(newId(), card, line, englishOnly ? [] : languages),
        );
        continue;
      }

      const input = importLabel(line);
      const position = offset + index + 1;
      if (checked.number) {
        issues.push({
          line: position,
          input,
          kind: "noUsableScan",
          message: `No usable scan found in ${attempted.join(", ")}.`,
          printLookup: { ...checked.number, languages: attempted },
        });
        missingPrints.push({ input, languages });
      } else {
        issues.push({
          line: position,
          input,
          kind: "notFound",
          message:
            "Exact card or printing not found. Correct the name/set rather than silently choosing another printing.",
        });
      }
    }
  }
  return { entries, issues, missingPrints };
}
