import { XMLParser, XMLValidator } from "fast-xml-parser";
import Papa from "papaparse";
import { z } from "zod";
import { boardSchema, zoneSchema } from "./models.ts";

export const importLineSchema = z.object({
  name: z.string().trim().min(1).max(300),
  quantity: z.number().int().min(1).max(250),
  zone: zoneSchema,
  board: boardSchema,
  set: z.string().max(20).default(""),
  collectorNumber: z.string().max(40).default(""),
});
export type ImportLine = z.infer<typeof importLineSchema>;
export interface ImportIssue {
  line: number;
  input: string;
  message: string;
  severity?: "warning";
}
export interface ParsedDecklist {
  entries: ImportLine[];
  /** Source line (1-based) of the first line that produced each entry. */
  lines: number[];
  issues: ImportIssue[];
  format: string;
}

function boardAlias(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function isCompanionHeading(alias: string): boolean {
  return alias === "companion" || alias === "companions";
}

function zoneFrom(alias: string): ImportLine["zone"] | undefined {
  switch (alias) {
    case "deck":
    case "main":
    case "mainboard":
      return "main";
    case "commander":
    case "commanders":
      return "commander";
    case "side":
    case "sideboard":
      return "side";
    case "maybe":
    case "maybeboard":
    case "considering":
      return "maybe";
    case "token":
    case "tokens":
      return "tokens";
  }
}

function boardComment(line: string) {
  return /^\/\/ Board:\s*(.+)$/.exec(line)?.[1]?.trim() || undefined;
}

function namedMaybeBoard(label: string, alias: string) {
  if (alias === "maybeboard" || alias === "considering")
    return label.replace(/^\/\/\s*/, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

const csvComment = "// Board:";

function lineBreakCount(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

function csvSourceLines(
  text: string,
  firstLine: number,
  { delimiter, linebreak }: Papa.ParseMeta,
) {
  const newline = linebreak === "\r\n" || linebreak === "\r" ? linebreak : "\n";
  const recordLines: number[] = [];
  const nonEmptyLines: number[] = [];
  const boards = new Map<number, string>();
  const headingLines = new Set<number>();
  let offset = 0;
  let line = firstLine;
  let board: string | undefined;
  Papa.parse<string[]>(text, {
    delimiter,
    newline,
    comments: csvComment,
    step: ({ data, meta }) => {
      while (text.startsWith(csvComment, offset)) {
        const end = text.indexOf(newline, offset);
        if (end === -1) break;
        board = boardComment(text.slice(offset, end));
        const next = end + newline.length;
        line += lineBreakCount(text.slice(offset, next));
        offset = next;
      }
      recordLines.push(line);
      if (data.join("").trim()) {
        nonEmptyLines.push(line);
        if (board) boards.set(line, board);
      }
      if (data.length === 1 && isCompanionHeading(boardAlias(data[0] ?? "")))
        headingLines.add(line);
      line += lineBreakCount(text.slice(offset, meta.cursor));
      offset = meta.cursor;
    },
  });
  return { recordLines, nonEmptyLines, boards, headingLines };
}

export function parseDecklist(input: string): ParsedDecklist {
  if (input.length > 200_000) throw new Error("Decklist exceeds 200 KB");
  const source = input.replace(/^\uFEFF/, "");
  const text = source.trim();
  const result: ParsedDecklist = {
    entries: [],
    lines: [],
    issues: [],
    format: "Text / Arena",
  };
  const add = (value: unknown, line: number, source: string) => {
    const parsed = importLineSchema.safeParse(value);
    if (parsed.success) {
      result.entries.push(parsed.data);
      result.lines.push(line);
    } else
      result.issues.push({
        line,
        input: source,
        message: "Expected a card name and a quantity between 1 and 250",
      });
  };
  if (text.startsWith("<")) {
    result.format = "MTGO XML";
    if (
      /<!DOCTYPE|<!ENTITY/i.test(text) ||
      XMLValidator.validate(text) !== true
    )
      throw new Error("Invalid or unsafe MTGO XML");
    const record = z.object({
      Name: z.string().min(1),
      Quantity: z.coerce.number(),
      Sideboard: z.string().optional(),
    });
    const parsed: unknown = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseAttributeValue: false,
    }).parse(text);
    const document = z
      .object({ Deck: z.object({ Cards: z.union([record, z.array(record)]) }) })
      .safeParse(parsed);
    if (!document.success)
      throw new Error(
        "MTGO files must include Cards with Name and Quantity attributes. Export a named decklist if only CatID values are present.",
      );
    const cards = Array.isArray(document.data.Deck.Cards)
      ? document.data.Deck.Cards
      : [document.data.Deck.Cards];
    cards.forEach((card, index) => {
      add(
        {
          name: card.Name,
          quantity: card.Quantity,
          zone: /^(true|1)$/i.test(card.Sideboard ?? "") ? "side" : "main",
        },
        index + 1,
        card.Name,
      );
    });
  } else if (
    /^(.*[;,])?(name|card name)[;,]/i.test(text.split(/\r?\n/)[0] ?? "") ||
    /^(name|card name),/i.test(text)
  ) {
    result.format = "CSV";
    const csv = Papa.parse<Record<string, string>>(text, {
      header: true,
      comments: csvComment,
      skipEmptyLines: "greedy",
      transformHeader: (header) => header.toLowerCase().replace(/[^a-z]/g, ""),
    });
    const firstLine =
      1 +
      lineBreakCount(
        source.slice(0, source.length - source.trimStart().length),
      );
    const { recordLines, nonEmptyLines, boards, headingLines } = csvSourceLines(
      text,
      firstLine,
      csv.meta,
    );
    const [headerLine = firstLine, ...dataLines] = nonEmptyLines;
    const invalidLines = new Set<number>();
    for (const error of csv.errors) {
      const lines = error.type === "Quotes" ? recordLines : dataLines;
      const line = error.row === undefined ? undefined : lines[error.row];
      if (line !== undefined) invalidLines.add(line);
      result.issues.push({
        line: line ?? headerLine,
        input: "CSV row",
        message: error.message,
      });
    }
    csv.data.forEach((row, index) => {
      const line = dataLines[index] ?? headerLine;
      if (headingLines.has(line) || invalidLines.has(line)) return;
      const board = (row.board ?? row.zone ?? "").trim();
      const alias = boardAlias(board);
      const zone = zoneFrom(alias);
      if (board && !zone)
        result.issues.push({
          line,
          input: board,
          message: "Unrecognized board; imported to Mainboard",
          severity: "warning",
        });
      add(
        {
          name: row.name ?? row.cardname,
          quantity: Number(row.quantity ?? row.count ?? "1"),
          set: (row.setcode ?? row.set ?? "").toLowerCase(),
          collectorNumber: row.collectornumber ?? "",
          zone: zone ?? "main",
          board: board
            ? zone
              ? namedMaybeBoard(board, alias)
              : board
            : boards.get(line),
        },
        line,
        row.name ?? row.cardname ?? "",
      );
    });
  } else {
    let zone: ImportLine["zone"] = "main";
    let board: string | undefined;
    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (!line) return;
      const alias = boardAlias(line);
      const header = zoneFrom(alias);
      if (header) {
        zone = header;
        board = namedMaybeBoard(line, alias);
        return;
      }
      if (line.startsWith("// Board:")) {
        board = boardComment(line);
        return;
      }
      if (isCompanionHeading(alias)) return;
      if (/^(\/\/|#)/.test(line)) return;
      const sideboard = /^SB:\s*/i.test(line);
      const clean = line.replace(/^SB:\s*/i, "").replace(/\s+\*F\*\s*$/i, "");
      const match =
        /^(?:(\d+)x?\s+)?(.+?)(?:\s+\(([^)]+)\)(?:\s+([\w★-]+))?|\s+\[([^\]]+)\])?$/.exec(
          clean,
        );
      if (!match) {
        result.issues.push({
          line: index + 1,
          input: line,
          message: "Unrecognized line",
        });
        return;
      }
      add(
        {
          name: match[2],
          quantity: Number(match[1] ?? 1),
          set: (match[3] ?? match[5] ?? "").toLowerCase(),
          collectorNumber: match[4] ?? "",
          zone: sideboard ? "side" : zone,
          board: sideboard ? undefined : board,
        },
        index + 1,
        line,
      );
    });
  }
  const merged = new Map<string, { entry: ImportLine; line: number }>();
  result.entries.forEach((entry, index) => {
    const line = result.lines[index] ?? 0;
    const key = JSON.stringify([
      entry.name.toLowerCase(),
      entry.set,
      entry.collectorNumber,
      entry.zone,
      entry.board,
    ]);
    const old = merged.get(key);
    if (old && old.entry.quantity + entry.quantity > 250)
      result.issues.push({
        line,
        input: entry.name,
        message: "Combined quantity exceeds 250",
      });
    else
      merged.set(key, {
        entry: {
          ...entry,
          quantity: (old?.entry.quantity ?? 0) + entry.quantity,
        },
        line: old?.line ?? line,
      });
  });
  result.entries = [...merged.values()].map((item) => item.entry);
  result.lines = [...merged.values()].map((item) => item.line);
  if (
    result.entries.length > 1000 ||
    result.entries.reduce((n, entry) => n + entry.quantity, 0) > 1500
  )
    throw new Error("Decklists are limited to 1,000 entries and 1,500 cards");
  return result;
}
