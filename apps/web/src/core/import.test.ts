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

  it.each([
    [
      "normal",
      "commanders",
      "companions",
      "testing Pool",
      "Commander",
      "commander",
    ],
    [
      "lookalike custom",
      "commanders",
      "companions",
      "commanders2",
      "Commander",
      "commander",
    ],
    [
      "mixed-case keys",
      "Commanders",
      "COMPANIONS",
      "testing Pool",
      "Commander",
      "commander",
    ],
    ["empty commanders", "", "companions", "testing Pool", "Deck", "main"],
    [
      "empty commanders with lookalike custom",
      "",
      "companions",
      "commanders2",
      "Deck",
      "main",
    ],
  ])(
    "imports Moxfield companions in %s boards regardless of order",
    (_case, commanders, companions, custom, heading, zone) => {
      const sections = [
        commanders ? `${commanders}\n1 Jori En, Ruin Diver` : "",
        `${heading}\n// Board: ${companions}\n1 Lurrus of the Dream-Den`,
        `Deck\n// Board: ${custom}\n1 Opt`,
        "",
      ];
      function permutations(values: string[]): string[][] {
        if (!values.length) return [[]];
        return values.flatMap((value, index) =>
          permutations(values.filter((_, i) => i !== index)).map((tail) => [
            value,
            ...tail,
          ]),
        );
      }
      for (const order of permutations(sections)) {
        const input = order.filter(Boolean).join("\n");
        const result = parseDecklist(input);
        expect(result.entries, input).toHaveLength(commanders ? 3 : 2);
        expect(
          result.entries.find(({ name }) => name === "Lurrus of the Dream-Den"),
          input,
        ).toMatchObject({ zone });
        expect(
          result.entries.find(({ name }) => name === "Opt"),
          input,
        ).toMatchObject({ zone: "main" });
        expect(result.issues, input).toEqual([]);
      }
    },
  );

  it("does not treat lookalike board names as aliases in text or CSV", () => {
    const text = parseDecklist("Deck\n// sideboard2\n1 Shock");
    expect(text.entries).toMatchObject([{ name: "Shock", zone: "main" }]);
    const formatted = parseDecklist("Deck\n// Side-Board 2:\n1 Shock");
    expect(formatted.entries).toEqual(text.entries);
    const csv = parseDecklist(
      "Name,Quantity,Board\nShock,1,Sideboard2\nNegate,1,Sideboard",
    );
    expect(csv.entries).toMatchObject([
      { name: "Shock", zone: "main" },
      { name: "Negate", zone: "side" },
    ]);
  });

  it.each([
    ["deck", "main"],
    ["main", "main"],
    ["main board", "main"],
    ["commander", "commander"],
    ["commanders", "commander"],
    ["side", "side"],
    ["side board", "side"],
    ["maybe", "maybe"],
    ["maybe board", "maybe"],
    ["considering", "maybe"],
    ["token", "tokens"],
    ["tokens", "tokens"],
  ])(
    "recognizes the text heading %s and its formatted variants",
    (alias, zone) => {
      const preceding = zone === "main" ? "Sideboard" : "Deck";
      const variants = new Set([
        alias.replaceAll(" ", ""),
        alias.replaceAll(" ", "").toUpperCase(),
        alias.replace(/\b\w/g, (letter) => letter.toUpperCase()),
        alias.replaceAll(" ", "-"),
        `${alias.replaceAll(" ", "")}:`,
        `// ${alias.toUpperCase().replaceAll(" ", " - ")}:`,
      ]);
      for (const heading of variants) {
        const parsed = parseDecklist(`${preceding}\n${heading}\n1 Negate`);
        expect(parsed.entries, heading).toMatchObject([
          { name: "Negate", zone },
        ]);
        expect(parsed.issues, heading).toEqual([]);
      }
    },
  );

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
