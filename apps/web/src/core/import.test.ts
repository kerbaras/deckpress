import { describe, expect, it } from "vitest";
import { parseDecklist } from "./import.ts";

describe("decklist import", () => {
  it("preserves exact printings, zones and double-faced names across text formats", () => {
    const result = parseDecklist(
      "Commander\n1 Atraxa, Praetors' Voice\nDeck\n4 Lightning Bolt (M10) 146\n1x Sol Ring [CMM]\n2 Fire // Ice\nSideboard\n1 Negate\n// ignored\nMaybeboard\n0 Invalid\n1 Brainstorm",
    );
    expect(
      result.entries.map(({ name, quantity, zone, set, collectorNumber }) => ({
        name,
        quantity,
        zone,
        set,
        collectorNumber,
      })),
    ).toEqual([
      {
        name: "Atraxa, Praetors' Voice",
        quantity: 1,
        zone: "commander",
        set: "",
        collectorNumber: "",
      },
      {
        name: "Lightning Bolt",
        quantity: 4,
        zone: "main",
        set: "m10",
        collectorNumber: "146",
      },
      {
        name: "Sol Ring",
        quantity: 1,
        zone: "main",
        set: "cmm",
        collectorNumber: "",
      },
      {
        name: "Fire // Ice",
        quantity: 2,
        zone: "main",
        set: "",
        collectorNumber: "",
      },
      {
        name: "Negate",
        quantity: 1,
        zone: "side",
        set: "",
        collectorNumber: "",
      },
      {
        name: "Brainstorm",
        quantity: 1,
        zone: "maybe",
        set: "",
        collectorNumber: "",
      },
    ]);
    expect(result.issues).toHaveLength(1);
  });

  it("reads labeled Moxfield boards without treating a custom label as a card", () => {
    const result = parseDecklist(
      "mainboard\n4 Lightning Bolt (m10) 146\nsideboard\n2 Negate\nDeck\n// Board: testing Pool\n1 Opt",
    );
    expect(result.entries).toMatchObject([
      {
        name: "Lightning Bolt",
        zone: "main",
        set: "m10",
        collectorNumber: "146",
      },
      { name: "Negate", zone: "side" },
      { name: "Opt", zone: "main" },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("keeps Moxfield companions in the preceding Commander section", () => {
    const result = parseDecklist(
      "commanders\n1 Jori En, Ruin Diver\ncompanions\n1 Lurrus of the Dream-Den\nmainboard\n4 Lightning Bolt",
    );
    expect(
      result.entries.find(({ name }) => name === "Lurrus of the Dream-Den"),
    ).toMatchObject({ zone: "commander" });
  });

  it("does not treat lookalike board names as aliases in text or CSV", () => {
    const text = parseDecklist("Deck\n// sideboard2\n1 Shock");
    expect(text.entries).toMatchObject([{ name: "Shock", zone: "main" }]);
    const csv = parseDecklist(
      "Name,Quantity,Board\nShock,1,Sideboard2\nNegate,1,Sideboard",
    );
    expect(csv.entries).toMatchObject([
      { name: "Shock", zone: "main" },
      { name: "Negate", zone: "side" },
    ]);
  });

  it("round-trips a card through text and CSV containing the same board header", () => {
    const header = "// Board: testing Pool";
    const text = parseDecklist(`Deck\n${header}\n2 Island`);
    expect(text.entries).toMatchObject([
      { name: "Island", quantity: 2, zone: "main" },
    ]);
    const csv = parseDecklist(
      [
        "Name,Quantity",
        header,
        ...text.entries.map(({ name, quantity }) => `${name},${quantity}`),
      ].join("\n"),
    );
    expect(csv.format).toBe("CSV");
    expect(csv.entries).toEqual(text.entries);
    expect(csv.issues).toEqual([]);
    const roundTrip = parseDecklist(
      [
        "Deck",
        header,
        ...csv.entries.map(({ name, quantity }) => `${quantity} ${name}`),
      ].join("\n"),
    );
    expect(roundTrip).toEqual(text);
  });

  it("reads quoted CSV names and MTGO XML without interpreting entities", () => {
    const csv = parseDecklist(
      'Name,Quantity,Set Code,Collector Number,Board\n"Atraxa, Praetors\' Voice",1,C16,28,Commander',
    );
    expect(csv.entries[0]).toMatchObject({
      name: "Atraxa, Praetors' Voice",
      quantity: 1,
      set: "c16",
      collectorNumber: "28",
      zone: "commander",
    });
    const xml = parseDecklist(
      '<Deck><Cards Quantity="2" Sideboard="true" Name="Fire &amp; Ice" /></Deck>',
    );
    expect(xml.entries[0]).toMatchObject({
      name: "Fire & Ice",
      quantity: 2,
      zone: "side",
    });
    expect(() =>
      parseDecklist(
        '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><Deck/>',
      ),
    ).toThrow();
  });

  it("merges repeated entries without merging different printings or zones", () => {
    const result = parseDecklist(
      "2 Island\n3 Island\n1 Island (M21) 265\nSideboard\n1 Island",
    );
    expect(result.entries.map((entry) => entry.quantity)).toEqual([5, 1, 1]);
    expect(result.lines).toEqual([1, 3, 5]);
    expect(parseDecklist("9999 Island").issues).toHaveLength(1);
  });
});
