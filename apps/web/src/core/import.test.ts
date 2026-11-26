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
