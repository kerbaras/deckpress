import type { PrintLanguagePreferences, ResolvedCards } from "../../api.ts";
import { cardLookupName, splitCardAlternative } from "../../core/card-names.ts";
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
const splitSearchBatch = 20;

type NumberedPrint = NonNullable<ReturnType<typeof printNumber>>;
type Candidate = { raw: Record<string, unknown>; card: Card | undefined };
type ImportRow = { line: ImportLine; candidate: Candidate | undefined };

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
  const name = cardLookupName(line.name);
  return line.set ? { name, set: line.set } : { name };
}

function importLabel({ name, quantity, set, collectorNumber }: ImportLine) {
  return set
    ? `${quantity} ${name} (${set}) ${collectorNumber}`.trimEnd()
    : `${quantity} ${name}`;
}

function fullNameMatches(raw: Record<string, unknown>, wanted: string) {
  if (nameMatches(raw, wanted)) return true;
  const faces = recordList(raw.card_faces);
  if (faces.length < 2) return false;
  const names = faces.map((face) => face.printed_name ?? face.name);
  return (
    names.every((name) => typeof name === "string") &&
    foldName(names.join(" // ")) === wanted
  );
}

function findCandidate(
  cards: Candidate[],
  line: ImportLine,
  allowFaces: boolean,
) {
  const wanted = foldName(line.name);
  let best: Candidate | undefined;
  let bestRank = -1;
  for (const candidate of cards) {
    const { raw, card } = candidate;
    const number = printNumber(raw);
    if (
      !number ||
      (line.set && number.set !== line.set) ||
      (line.collectorNumber && number.collectorNumber !== line.collectorNumber)
    )
      continue;
    const full =
      Boolean(line.set && line.collectorNumber) || fullNameMatches(raw, wanted);
    if (
      !full &&
      (!allowFaces ||
        cardLookupName(line.name) !== line.name ||
        !recordList(raw.card_faces).some((face) => nameMatches(face, wanted)))
    )
      continue;
    const rank = (full ? 2 : 0) + (card ? 1 : 0);
    if (rank <= bestRank) continue;
    best = candidate;
    bestRank = rank;
  }
  return best;
}

function exactNameQuery(name: string) {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `!"${escaped}"`;
}

async function resolveSplitNames(api: Scryfall, rows: ImportRow[]) {
  const queries = new Map<string, { row: ImportRow; line: ImportLine }[]>();
  for (const row of rows) {
    const { line } = row;
    if (row.candidate || (line.set && line.collectorNumber)) continue;
    const name = splitCardAlternative(line.name);
    if (!name || (line.set && !/^[a-z\d]+$/i.test(line.set))) continue;
    const clause = `(${exactNameQuery(name)}${line.set ? ` set:${line.set}` : ""})`;
    const lookup = { row, line: { ...line, name } };
    const group = queries.get(clause);
    if (group) group.push(lookup);
    else queries.set(clause, [lookup]);
  }
  const unique = [...queries.values()].some((group) =>
    group.some(({ line }) => line.set || line.collectorNumber),
  )
    ? "prints"
    : "cards";
  await searchBatches(
    { search: (query, page) => api.search(query, page, unique) },
    queries.keys(),
    ["include:extras"],
    (rawCards, batch) => {
      const lookups = batch.flatMap((term) => queries.get(term) ?? []);
      const cards = rawCards.map((raw) => ({ raw, card: usableCard(raw) }));
      for (const { row, line } of lookups) {
        if (row.candidate?.card) continue;
        const candidate = findCandidate(cards, line, false);
        if (candidate?.card || (!row.candidate && candidate)) {
          row.line = line;
          row.candidate = candidate;
        }
      }
      return lookups.every(({ row }) => row.candidate?.card);
    },
    splitSearchBatch,
  );
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
      let query = original
        ? `oracleid:${original.oracleId}`
        : exactNameQuery(line.name);
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
              fullNameMatches(raw, foldName(line.name));
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

  const rows: ImportRow[] = [];
  for (let offset = 0; offset < lines.length; offset += collectionBatch) {
    const batch = lines.slice(offset, offset + collectionBatch);
    const collection = await api.collection(batch.map(identifier));
    const cards = collection.map((raw) => ({ raw, card: usableCard(raw) }));
    rows.push(
      ...batch.map((line) => ({
        line,
        candidate: findCandidate(cards, line, true),
      })),
    );
  }
  await resolveSplitNames(api, rows);
  const resolutions: ImportResolution[] = rows.map(({ line, candidate }) => ({
    line,
    original: candidate?.card,
    number: candidate && printNumber(candidate.raw),
    card: undefined,
  }));
  for (let offset = 0; offset < resolutions.length; offset += collectionBatch) {
    const batch = resolutions.slice(offset, offset + collectionBatch);
    for (const lang of attempted) {
      await resolveImportLanguage(api, batch, lang, englishOnly);
    }
  }
  for (const [index, { line, card, number }] of resolutions.entries()) {
    if (card) {
      entries.push(
        resolvedEntry(newId(), card, line, englishOnly ? [] : languages),
      );
      continue;
    }

    const input = importLabel(line);
    const position = index + 1;
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
  return { entries, issues, missingPrints };
}
