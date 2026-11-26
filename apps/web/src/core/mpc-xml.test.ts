import { expect, it, vi } from "vitest";
import { artSchema, frontArt } from "./models.ts";
import {
  exportMpcXml,
  importMpcXml,
  isMpcXml,
  parseMpcXml,
} from "./mpc-xml.ts";

const island = "1OAw4l9RYbgYrmnyYeR1iVDoIS6_aus49";
const rite = "1wlrM7pNHQ5NqS9GY5LWH7Hd04TtNgHI4";
const lotus = "16g2UamJ2jzwNHovLesvsinvd6_qPkZfy";
const customBack = "alternateBack";
const input = `<?xml version="1.0"?>
<order>
  <details><quantity>5</quantity><bracket>18</bracket><stock>(S30) Standard Smooth</stock><foil>false</foil></details>
  <fronts>
    <card><id>${island}</id><slots>4,0,1,3</slots><name>Island (Unsanctioned).png</name><query>island</query></card>
    <card><id>${rite}</id><sourceType>Google Drive</sourceType><slots>2</slots><name>Rite of Flame.png</name><query>rite of flame</query></card>
  </fronts>
  <backs><card><id>${customBack}</id><slots>3</slots><name>Custom.png</name><query>b:custom</query></card></backs>
  <cardback>${lotus}</cardback>
</order>`;

function lookup(ids: string[]) {
  return Promise.resolve(
    ids.map((id) => ({
      art: artSchema.parse({
        id: `mpc:${id}`,
        provider: "mpc",
        name: id === island ? "Island & sea" : id,
        imageUrl: `https://drive.google.com/uc?id=${id}`,
        thumbnailUrl: `https://drive.google.com/thumbnail?id=${id}`,
        source: "Fixture",
      }),
      filename: id === island ? "Island & sea.png" : `${id}.png`,
      query: id === island ? "island & sea" : id,
    })),
  );
}

it("round-trips ordered MPC Autofill fronts, copies, and common/explicit backs", async () => {
  expect(isMpcXml(input)).toBe(true);
  expect(isMpcXml('<?xml version="1.0"?><Deck/>')).toBe(false);
  const resolve = vi.fn(lookup);
  const entries = await importMpcXml(input, resolve);
  expect(resolve).toHaveBeenCalledWith(
    [lotus, island, rite, customBack].sort(),
  );
  expect(entries.map((entry) => entry.quantity)).toEqual([2, 1, 1, 1]);
  const xml = await exportMpcXml(entries, resolve);
  expect(xml).toContain("<name>Island &amp; sea.png</name>");
  expect(xml).toContain("<slots>0,1,3,4</slots>");
  expect(parseMpcXml(xml)).toEqual([
    { front: island, back: lotus },
    { front: island, back: lotus },
    { front: rite, back: lotus },
    { front: island, back: customBack },
    { front: island, back: lotus },
  ]);
  const allCommon = input
    .replace("<backs>", "<ignored>")
    .replace("</backs>", "</ignored>");
  const commonXml = await exportMpcXml(
    await importMpcXml(allCommon, resolve),
    resolve,
  );
  expect(commonXml).toContain(`<cardback>${lotus}</cardback>`);
  expect(commonXml).not.toContain("<backs>");
});

it("rejects unsafe, incomplete, duplicate-slot and unavailable MPC artwork", async () => {
  expect(() =>
    parseMpcXml(`<!DOCTYPE order SYSTEM "file:///test">${input}`),
  ).toThrow("unsafe");
  expect(() => parseMpcXml(input.replace("4,0,1,3", "4,0,1,3,4"))).toThrow(
    "repeated",
  );
  expect(() => parseMpcXml(input.replace("4,0,1,3", "4,0,1"))).toThrow(
    "front slot 3",
  );
  expect(() =>
    parseMpcXml(input.replace("Google Drive", "Local File")),
  ).toThrow("not supported");
  await expect(importMpcXml(input, async () => [])).rejects.toThrow(
    "no longer available",
  );
  const entries = await importMpcXml(input, lookup);
  const first = entries[0];
  if (!first) throw new Error("Missing first entry");
  first.selectedArt = { ...frontArt(first), provider: "scryfall" };
  await expect(exportMpcXml(entries, lookup)).rejects.toThrow(
    "Choose MPC Autofill art",
  );
});
