import { XMLParser, XMLValidator } from "fast-xml-parser";
import Papa from "papaparse";
import { z } from "zod";
import { zoneSchema } from "./models.ts";

export const importLineSchema = z.object({
  name: z.string().trim().min(1).max(300),
  quantity: z.number().int().min(1).max(250),
  zone: zoneSchema,
  set: z.string().max(20).default(""),
  collectorNumber: z.string().max(40).default(""),
});
export type ImportLine = z.infer<typeof importLineSchema>;
export interface ImportIssue {
  line: number;
  input: string;
  message: string;
}
export interface ParsedDecklist {
  entries: ImportLine[];
  issues: ImportIssue[];
  format: string;
}

function zoneFrom(value: string): ImportLine["zone"] | undefined {
  return (
    {
      deck: "main",
      main: "main",
      mainboard: "main",
      commander: "commander",
      commanders: "commander",
      side: "side",
      sideboard: "side",
      maybe: "maybe",
      maybeboard: "maybe",
      considering: "maybe",
      token: "tokens",
      tokens: "tokens",
    } as const
  )[value.toLowerCase().replace(/[^a-z]/g, "") as "deck"];
}

export function parseDecklist(input: string): ParsedDecklist {
  if (input.length > 200_000) throw new Error("Decklist exceeds 200 KB");
  const text = input.replace(/^\uFEFF/, "").trim();
  const result: ParsedDecklist = {
    entries: [],
    issues: [],
    format: "Text / Arena",
  };
  const add = (value: unknown, line: number, source: string) => {
    const parsed = importLineSchema.safeParse(value);
    if (parsed.success) result.entries.push(parsed.data);
    else
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
      skipEmptyLines: "greedy",
      transformHeader: (header) => header.toLowerCase().replace(/[^a-z]/g, ""),
    });
    for (const error of csv.errors)
      result.issues.push({
        line: (error.row ?? 0) + 2,
        input: "CSV row",
        message: error.message,
      });
    csv.data.forEach((row, index) => {
      add(
        {
          name: row.name ?? row.cardname,
          quantity: Number(row.quantity ?? row.count ?? "1"),
          set: (row.setcode ?? row.set ?? "").toLowerCase(),
          collectorNumber: row.collectornumber ?? "",
          zone: zoneFrom(row.board ?? row.zone ?? "") ?? "main",
        },
        index + 2,
        row.name ?? row.cardname ?? "",
      );
    });
  } else {
    let zone: ImportLine["zone"] = "main";
    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (!line) return;
      const header = zoneFrom(line.replace(/^\/\/\s*/, ""));
      if (header) {
        zone = header;
        return;
      }
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
        },
        index + 1,
        line,
      );
    });
  }
  const merged = new Map<string, ImportLine>();
  for (const entry of result.entries) {
    const key = JSON.stringify([
      entry.name.toLowerCase(),
      entry.set,
      entry.collectorNumber,
      entry.zone,
    ]);
    const old = merged.get(key);
    if (old && old.quantity + entry.quantity > 250)
      result.issues.push({
        line: 0,
        input: entry.name,
        message: "Combined quantity exceeds 250",
      });
    else
      merged.set(key, {
        ...entry,
        quantity: (old?.quantity ?? 0) + entry.quantity,
      });
  }
  result.entries = [...merged.values()];
  if (
    result.entries.length > 1000 ||
    result.entries.reduce((n, entry) => n + entry.quantity, 0) > 1500
  )
    throw new Error("Decklists are limited to 1,000 entries and 1,500 cards");
  return result;
}
