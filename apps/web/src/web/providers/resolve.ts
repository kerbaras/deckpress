import type { PrintLanguagePreferences, ResolvedCards } from "../../api.ts";
import type { Card, DeckEntry, ImportLine } from "../../core/index.ts";
import type { Scryfall } from "./scryfall.ts";
import {
  foldName,
  nameMatches,
  printNumber,
  recordList,
  usableCard,
} from "./scryfall-card.ts";
import { searchBatches } from "./search-batches.ts";

const collectionBatch = 75;

type NumberedPrint = NonNullable<ReturnType<typeof printNumber>>;

type ImportResolution = {
  line: ImportLine;
  original: Card | undefined;
  number: NumberedPrint | undefined;
  card: Card | undefined;
};

function identifier(line: ImportLine) {
  if (line.set && line.collectorNumber) {
    return { set: line.set, collector_number: line.collectorNumber };
  }
  return line.set ? { name: line.name, set: line.set } : { name: line.name };
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

async function resolveImportLanguage(
  api: Scryfall,
  resolutions: ImportResolution[],
  lang: string,
  englishOnly: boolean,
) {
  const pending = new Map<string, ImportResolution[]>();
  for (const result of resolutions) {
    const { line, original } = result;
    if (result.card || (englishOnly && !original)) continue;
    if (original?.faces[0]?.language === lang) {
      result.card = original;
    } else if (line.set && line.collectorNumber) {
      const raw = await api.exact(line.set, line.collectorNumber, lang);
      const number = printNumber(raw);
      if (
        number?.set === line.set &&
        number.collectorNumber === line.collectorNumber &&
        raw.lang === lang &&
        (!original || (raw.oracle_id ?? raw.id) === original.oracleId)
      ) {
        result.number ??= number;
        result.card = usableCard(raw);
      }
    } else {
      const escaped = line.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      let query = original ? `oracleid:${original.oracleId}` : `!"${escaped}"`;
      if (!original && line.set) {
        if (!/^[a-z\d]+$/i.test(line.set)) continue;
        query += ` set:${line.set}`;
      }
      const group = pending.get(query);
      if (group) group.push(result);
      else pending.set(query, [result]);
    }
  }

  await searchBatches(
    api,
    pending.keys(),
    ["game:paper", `lang:${lang}`],
    (cards, batch) => {
      const candidates = batch.flatMap((term) => pending.get(term) ?? []);
      for (const raw of cards) {
        const number = printNumber(raw);
        if (!number || raw.lang !== lang) continue;
        for (const result of candidates) {
          if (result.card) continue;
          const { line, original } = result;
          const matches = original
            ? (raw.oracle_id ?? raw.id) === original.oracleId
            : (!line.set || number.set === line.set) &&
              nameMatches(raw, foldName(line.name));
          if (!matches) continue;
          result.number ??= number;
          result.card = usableCard(raw);
        }
      }
      return candidates.every(({ card }) => card);
    },
  );
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
    const batch = lines.slice(offset, offset + collectionBatch);
    const collection = await api.collection(batch.map(identifier));
    const cards = collection.map((raw) => ({ raw, card: usableCard(raw) }));
    const resolutions = batch.map((line): ImportResolution => {
      const wanted = foldName(line.name);
      const candidates = cards.filter(({ raw }) =>
        matchesLine(raw, line, wanted),
      );
      const candidate =
        candidates.find(({ card }) => card !== undefined) ?? candidates[0];
      return {
        line,
        original: candidate?.card,
        number: candidate && printNumber(candidate.raw),
        card: undefined,
      };
    });
    for (const lang of attempted) {
      await resolveImportLanguage(api, resolutions, lang, englishOnly);
    }
    for (const [index, { line, card, number }] of resolutions.entries()) {
      if (card) {
        entries.push(
          resolvedEntry(newId(), card, line, englishOnly ? [] : languages),
        );
        continue;
      }

      const input = importLabel(line);
      const position = offset + index + 1;
      if (number) {
        issues.push({
          line: position,
          input,
          kind: "noUsableScan",
          message: `No usable scan found in ${attempted.join(", ")}.`,
          printLookup: { ...number, languages: attempted },
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
