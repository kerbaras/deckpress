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

const collectionBatch = 75;
const splitSearchBatch = 20;

type NumberedPrint = NonNullable<ReturnType<typeof printNumber>>;
type Candidate = { raw: Record<string, unknown>; card: Card | undefined };
type ImportRow = { line: ImportLine; candidate: Candidate | undefined };

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
      Boolean(line.set && line.collectorNumber) || nameMatches(raw, wanted);
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
  const clauses = [...queries.entries()];
  for (let offset = 0; offset < clauses.length; offset += splitSearchBatch) {
    const chunk = clauses.slice(offset, offset + splitSearchBatch);
    const lookups = chunk.flatMap(([, group]) => group);
    const query = `(${chunk.map(([clause]) => clause).join(" or ")}) include:extras`;
    const unique = lookups.some(({ line }) => line.set || line.collectorNumber)
      ? "prints"
      : "cards";
    for (let page = 1; page <= 100; page++) {
      const result = await api.search(query, page, unique);
      const cards = result.cards.map((raw) => ({ raw, card: usableCard(raw) }));
      for (const { row, line } of lookups) {
        if (row.candidate?.card) continue;
        const candidate = findCandidate(cards, line, false);
        if (candidate?.card || (!row.candidate && candidate)) {
          row.line = line;
          row.candidate = candidate;
        }
      }
      if (!result.hasMore || lookups.every(({ row }) => row.candidate?.card))
        break;
    }
  }
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

  let query = original
    ? `oracleid:${original.oracleId}`
    : exactNameQuery(line.name);
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
  for (const [index, { line, candidate }] of rows.entries()) {
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
    const position = index + 1;
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
  return { entries, issues, missingPrints };
}
