import { z } from "zod";
import { artSchema, backArt, type DeckEntry, frontArt } from "./models.ts";

export const mpcXmlFormat = "MPC Autofill XML";
const maxSlots = 612;
const idPattern = /^[\w-]{1,120}$/;

export const mpcArtworkSchema = z.object({
  art: artSchema,
  filename: z.string(),
  query: z.string(),
});
type MpcArtwork = z.infer<typeof mpcArtworkSchema>;
type MpcSlot = { front: string; back: string | null };
type Lookup = (ids: string[]) => Promise<MpcArtwork[]>;

export function isMpcXml(text: string): boolean {
  let xml = text.trimStart();
  while (xml.startsWith("<?") || xml.startsWith("<!--")) {
    const end = xml.startsWith("<?") ? "?>" : "-->";
    const found = xml.indexOf(end, end === "?>" ? 2 : 4);
    if (found < 0) return false;
    xml = xml.slice(found + end.length).trimStart();
  }
  return /^<order(?=[\s>])/.test(xml);
}

function child(element: Element | undefined, tag: string): Element | undefined {
  return Array.from(element?.children ?? []).find(
    (node) => node.tagName === tag,
  );
}

function value(element: Element | undefined, tag: string): string {
  return child(element, tag)?.textContent?.trim() ?? "";
}

export function parseMpcXml(text: string): MpcSlot[] {
  if (text.length > 512 * 1024)
    throw new Error("MPC Autofill XML exceeds 512 KB");
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error("Invalid or unsafe MPC Autofill XML");
  const document = new DOMParser().parseFromString(text, "application/xml");
  const order = document.documentElement;
  if (order.tagName !== "order" || order.namespaceURI)
    throw new Error("Expected an MPC Autofill <order> document");
  const quantityText = value(child(order, "details"), "quantity");
  const quantity = Number(quantityText);
  if (!/^\d+$/.test(quantityText) || quantity < 1 || quantity > maxSlots)
    throw new Error(`MPC Autofill orders must have 1–${maxSlots} cards`);
  const common = value(order, "cardback");
  if (common && !idPattern.test(common))
    throw new Error("Invalid MPC Autofill common card back ID");
  const readFace = (tag: string) => {
    const side = new Map<number, string>();
    for (const card of Array.from(child(order, tag)?.children ?? [])) {
      if (card.tagName !== "card") continue;
      const id = value(card, "id");
      if (!idPattern.test(id))
        throw new Error(`Invalid MPC Autofill artwork ID: ${id || "(empty)"}`);
      const source = value(card, "sourceType");
      if (source && source !== "Google Drive")
        throw new Error(
          `MPC Autofill source "${source}" is not supported; use Google Drive art.`,
        );
      for (const item of value(card, "slots").split(",")) {
        const slot = Number(item);
        if (!/^\d+$/.test(item.trim()) || slot >= quantity || side.has(slot))
          throw new Error(
            `Invalid or repeated MPC Autofill slot "${item}" in ${tag}`,
          );
        side.set(slot, id);
      }
    }
    return side;
  };
  const fronts = readFace("fronts");
  const backs = readFace("backs");
  return Array.from({ length: quantity }, (_, slot) => {
    const front = fronts.get(slot);
    if (!front)
      throw new Error(`Missing MPC Autofill artwork for front slot ${slot}`);
    return { front, back: backs.get(slot) ?? (common || null) };
  });
}

async function slotArtwork(slots: MpcSlot[], lookup: Lookup) {
  const ids = [
    ...new Set(
      slots.flatMap(({ front, back }) => (back ? [front, back] : [front])),
    ),
  ].sort();
  const selected = new Map(
    (await lookup(ids)).map((item) => [item.art.id, item]),
  );
  return (id: string) => {
    const artwork = selected.get(`mpc:${id}`);
    if (!artwork)
      throw new Error(`MPC Autofill artwork ${id} is no longer available.`);
    return artwork;
  };
}

export async function importMpcXml(
  text: string,
  lookup: Lookup,
): Promise<DeckEntry[]> {
  const slots = parseMpcXml(text);
  const artwork = await slotArtwork(slots, lookup);
  const entries: DeckEntry[] = [];
  let prior: MpcSlot | undefined;
  for (const slot of slots) {
    const last = entries.at(-1);
    if (
      last &&
      last.quantity < 250 &&
      prior?.front === slot.front &&
      prior.back === slot.back
    ) {
      last.quantity++;
      continue;
    }
    const front = artwork(slot.front);
    const back = slot.back ? artwork(slot.back).art : null;
    const id = crypto.randomUUID();
    entries.push({
      id: crypto.randomUUID(),
      card: {
        id,
        oracleId: id,
        name: front.art.name,
        typeLine: "",
        manaCost: "",
        manaValue: 0,
        colors: [],
        faces: back ? [front.art, back] : [front.art],
      },
      quantity: 1,
      zone: front.query.startsWith("t:") ? "tokens" : "main",
      selectedArt: null,
      selectedBack: null,
      excluded: false,
    });
    prior = slot;
  }
  return entries;
}

export async function exportMpcXml(
  entries: DeckEntry[],
  lookup: Lookup,
): Promise<string> {
  const readId = (name: string, art: ReturnType<typeof backArt>) => {
    const id = art?.id.slice(4);
    if (
      art?.provider !== "mpc" ||
      !art.id.startsWith("mpc:") ||
      !id ||
      !idPattern.test(id)
    )
      throw new Error(
        `Choose MPC Autofill art for ${name} before exporting XML.`,
      );
    return id;
  };
  const included = entries.filter((entry) => !entry.excluded);
  const quantity = included.reduce((n, entry) => n + entry.quantity, 0);
  if (quantity < 1 || quantity > maxSlots)
    throw new Error(`MPC Autofill orders must have 1–${maxSlots} cards`);
  const slots = included.flatMap((entry) => {
    const back = backArt(entry);
    const slot = {
      front: readId(entry.card.name, frontArt(entry)),
      back: back ? readId(`${entry.card.name} (back)`, back) : null,
    };
    return Array.from({ length: entry.quantity }, () => slot);
  });
  const commonBack = slots[0]?.back;
  if (!commonBack || slots.some((slot) => !slot.back))
    throw new Error(
      "Choose an MPC Autofill back for each card before exporting XML, or import an MPC Autofill order with a common back.",
    );
  const artwork = await slotArtwork(slots, lookup);
  artwork(commonBack);
  const doc = document.implementation.createDocument(null, "order");
  const order = doc.documentElement;
  const append = (parent: Element, tag: string, text = "") => {
    const node = doc.createElement(tag);
    node.textContent = text;
    parent.append(node);
    return node;
  };
  const details = append(order, "details");
  append(details, "quantity", String(slots.length));
  append(details, "stock", "(S30) Standard Smooth");
  append(details, "foil", "false");
  for (const face of ["front", "back"] as const) {
    const groups = new Map<string, number[]>();
    slots.forEach((slot, index) => {
      const id = slot[face];
      if (!id || (face === "back" && id === commonBack)) return;
      const indices = groups.get(id);
      if (indices) indices.push(index);
      else groups.set(id, [index]);
    });
    if (!groups.size) continue;
    const side = append(order, `${face}s`);
    for (const [id, indices] of groups) {
      const card = append(side, "card");
      const { filename, query } = artwork(id);
      append(card, "id", id);
      append(card, "sourceType", "Google Drive");
      append(card, "slots", indices.join(","));
      append(card, "name", filename);
      append(card, "query", query);
    }
  }
  append(order, "cardback", commonBack);
  return new XMLSerializer().serializeToString(doc);
}
