import Papa from "papaparse";
import { describe, expect, it, vi } from "vitest";
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
      { name: "Opt", zone: "main", board: "testing Pool" },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("keeps copies of the same printing on their named boards", () => {
    const result = parseDecklist(
      "Maybeboard\n1 Opt\nConsidering\n2 Opt\n1 Opt\nDeck\n// Board: testing Pool\n4 Opt\n\n// regular comment\n1 Shock\nSB: 1 Opt\nDeck\n1 Opt",
    );
    expect(
      result.entries.map(({ name, zone, board, quantity }) => [
        name,
        zone,
        board,
        quantity,
      ]),
    ).toEqual([
      ["Opt", "maybe", "Maybeboard", 1],
      ["Opt", "maybe", "Considering", 3],
      ["Opt", "main", "testing Pool", 4],
      ["Shock", "main", "testing Pool", 1],
      ["Opt", "side", undefined, 1],
      ["Opt", "main", undefined, 1],
    ]);
    expect(result.issues).toEqual([]);
  });

  it.each([
    ["normal", "commanders", "companions", "testing Pool", "Commander"],
    [
      "lookalike custom",
      "commanders",
      "companions",
      "commanders2",
      "Commander",
    ],
    [
      "mixed-case keys",
      "Commanders",
      "COMPANIONS",
      "testing Pool",
      "Commander",
    ],
    ["empty commanders", "", "companions", "testing Pool", "Deck"],
    [
      "empty commanders with lookalike custom",
      "",
      "companions",
      "commanders2",
      "Deck",
    ],
  ])(
    "imports Moxfield companions in %s boards into the Companion zone regardless of order",
    (_case, commanders, companions, custom, heading) => {
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
        ).toMatchObject({ zone: "companion" });
        expect(
          result.entries.find(({ name }) => name === "Lurrus of the Dream-Den")
            ?.board,
          input,
        ).toBeUndefined();
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
      "Name,Quantity,Board\nShock,1,Sideboard2\nOpt,1,Side-Board 2:\nNegate,1,Sideboard",
    );
    expect(csv.entries).toMatchObject([
      { name: "Shock", zone: "main" },
      { name: "Opt", zone: "main" },
      { name: "Negate", zone: "side" },
    ]);
  });

  it.each([
    ["Board", "Board"],
    ["Board", "testing Pool"],
    ["Board", "Sideboard2"],
    ["Zone", "Sideboard٢"],
    ["Zone", "Sideboardé"],
  ])(
    "warns before defaulting an unknown CSV %s value %j to Mainboard",
    (column, board) => {
      const csv = parseDecklist(`Name,Quantity,${column}\nOpt,1,${board}`);
      expect(csv.entries).toMatchObject([{ name: "Opt", zone: "main" }]);
      expect(csv.issues).toEqual([
        {
          line: 2,
          input: board,
          message: "Unrecognized board; imported to Mainboard",
          severity: "warning",
        },
      ]);
    },
  );

  it("defaults blank and missing CSV board values to Mainboard without warnings", () => {
    for (const input of [
      "Name,Quantity,Board\nOpt,1, ",
      "Name,Quantity\nOpt,1",
    ]) {
      const csv = parseDecklist(input);
      expect(csv.entries).toMatchObject([{ name: "Opt", zone: "main" }]);
      expect(csv.issues).toEqual([]);
    }
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
  ])("recognizes formatted %s aliases in text and CSV", (alias, zone) => {
    const preceding = zone === "main" ? "Sideboard" : "Deck";
    const spellings = [
      "",
      " ",
      "-",
      " - ",
      "  ",
      "\t",
      "_",
      "–",
      "—",
      "／",
    ].flatMap((separator) => {
      const spelling = alias.replaceAll(" ", separator);
      return [
        spelling,
        spelling.toUpperCase(),
        spelling.replace(/\b\w/g, (letter) => letter.toUpperCase()),
      ];
    });
    const variants = new Set(
      spellings.flatMap((spelling) =>
        ["", "// ", "//"].flatMap((prefix) =>
          ["", ":", "::", "!", "："].flatMap((suffix) => {
            const heading = `${prefix}${spelling}${suffix}`;
            return [heading, `  ${heading}  `];
          }),
        ),
      ),
    );
    for (const heading of variants) {
      const parsed = parseDecklist(`${preceding}\n${heading}\n1 Negate`);
      expect(parsed.entries, heading).toMatchObject([{ name: "Negate", zone }]);
      expect(parsed.issues, heading).toEqual([]);
      for (const column of ["Board", "Zone"]) {
        const csv = parseDecklist(
          `Name,Quantity,${column}\nNegate,1,"${heading}"`,
        );
        expect(csv.format).toBe("CSV");
        expect(csv.entries, `${column}: ${heading}`).toEqual(parsed.entries);
        expect(csv.issues, `${column}: ${heading}`).toEqual([]);
      }
    }
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

  it("does not interpret a labeled custom board as a formatted alias", () => {
    const label = "// Board: Side–Board";
    const text = parseDecklist(`Deck\n${label}\n1 Opt`);
    const csv = parseDecklist(`Name,Quantity\n${label}\nOpt,1`);
    expect(text.entries).toMatchObject([
      { name: "Opt", zone: "main", board: "Side–Board" },
    ]);
    expect(csv.entries).toEqual(text.entries);
    expect(text.issues).toEqual([]);
    expect(csv.issues).toEqual([]);
  });

  it("keeps labeled CSV board comments separate from quoted multiline cells", () => {
    const parsed = parseDecklist(
      'Name,Quantity,Notes\r\n// Board: testing Pool\r\nOpt,1,"line one\r\n// Board: not a header"\r\n\r\nShock,1,\r\n// Board: other Pool\r\nOpt,1,',
    );
    expect(parsed.entries).toMatchObject([
      { name: "Opt", board: "testing Pool" },
      { name: "Shock", board: "testing Pool" },
      { name: "Opt", board: "other Pool" },
    ]);
    expect(parsed.issues).toEqual([]);
  });

  it.each([
    "companions",
    "Companions:",
    "COMPANION",
    "// Com-panions:",
    "Com–panions：",
  ])("reads cards after the %s heading into the Companion zone", (heading) => {
    const result = parseDecklist(
      `Commander\n1 Jori En, Ruin Diver\n${heading}\n1 Lurrus of the Dream-Den\nSpirited Companion\n1 Companion\nDeck\n1 Opt`,
    );
    expect(result.entries).toMatchObject([
      { name: "Jori En, Ruin Diver", zone: "commander" },
      { name: "Lurrus of the Dream-Den", zone: "companion" },
      { name: "Spirited Companion", zone: "companion" },
      { name: "Companion", zone: "companion" },
      { name: "Opt", zone: "main" },
    ]);
    expect(result.entries[1]?.board).toBeUndefined();
    expect(result.lines).toEqual([2, 4, 5, 6, 8]);
    expect(result.issues).toEqual([]);
  });

  it("imports the Arena/MTGO Companion section with its printing", () => {
    const result = parseDecklist(
      "Companion\n1 Lurrus of the Dream-Den (IKO) 226\n\nDeck\n4 Lightning Bolt (M10) 146\n\nSideboard\n1 Negate",
    );
    expect(result.entries).toEqual([
      {
        name: "Lurrus of the Dream-Den",
        quantity: 1,
        zone: "companion",
        set: "iko",
        collectorNumber: "226",
      },
      expect.objectContaining({ name: "Lightning Bolt", zone: "main" }),
      expect.objectContaining({ name: "Negate", zone: "side" }),
    ]);
    expect(result.issues).toEqual([]);
  });

  it.each([
    [
      "between sections",
      "Commander\n1 Jori En, Ruin Diver\nCompanions\nDeck\n1 Opt",
    ],
    ["at the end", "Commander\n1 Jori En, Ruin Diver\nDeck\n1 Opt\nCompanion:"],
    ["alone", "// Companions"],
  ])("silently drops a bare Companion heading %s", (_case, input) => {
    const result = parseDecklist(input);
    expect(result.entries.map(({ zone }) => zone)).not.toContain("companion");
    expect(result.issues).toEqual([]);
  });

  it.each([",", ";"])(
    "maps CSV Companion board values and labels with %j to the Companion zone",
    (delimiter) => {
      const row = (...cells: string[]) => cells.join(delimiter);
      const result = parseDecklist(
        [
          row("Name", "Quantity", "Board"),
          row("Lurrus of the Dream-Den", "1", "Companions"),
          row('"Jegantha, the Wellspring"', "1", "COMPANION"),
          row("Opt", "1", ""),
          "// Board: Companions",
          row('"Kaheera, the Orphanguard"', "1", ""),
          row("Negate", "1", "Sideboard"),
        ].join("\r\n"),
      );
      expect(
        result.entries.map(({ name, zone, board }) => [name, zone, board]),
      ).toEqual([
        ["Lurrus of the Dream-Den", "companion", undefined],
        ["Jegantha, the Wellspring", "companion", undefined],
        ["Opt", "main", undefined],
        ["Kaheera, the Orphanguard", "companion", undefined],
        ["Negate", "side", undefined],
      ]);
      expect(result.issues).toEqual([]);
    },
  );

  it.each([",", ";"])(
    "silently skips heading-only CSV with %j",
    (delimiter) => {
      const result = parseDecklist(
        `${["Name", "Quantity", "Board"].join(delimiter)}\r\nCompanion\r\nCom–panions：`,
      );
      expect(result.format).toBe("CSV");
      expect(result.entries).toEqual([]);
      expect(result.issues).toEqual([]);
    },
  );

  it.each([
    ["LF comma-separated", "\n", ","],
    ["CRLF semicolon-separated", "\r\n", ";"],
  ])(
    "reports physical source lines for %s CSV",
    (_case, newline, delimiter) => {
      const result = parseDecklist(
        [
          "\uFEFF",
          `Name${delimiter}Quantity${delimiter}Notes${delimiter}Board`,
          "",
          ` ${delimiter}""${delimiter} `,
          "// Board: testing Pool",
          `Island${delimiter}200${delimiter}"A note with ""quotes""`,
          `// Board: part of the quoted field"${delimiter}`,
          `Opt${delimiter}invalid${delimiter}${delimiter}`,
          `Negate${delimiter}1${delimiter}${delimiter}Board${delimiter}extra`,
          `Island${delimiter}51${delimiter}${delimiter}`,
        ].join(newline),
      );
      expect(result.format).toBe("CSV");
      expect(result.entries).toMatchObject([
        { name: "Island", board: "testing Pool" },
      ]);
      expect(result.lines).toEqual([6]);
      expect(result.issues).toEqual([
        {
          line: 9,
          input: "CSV row",
          message: "Too many fields: expected 4 fields but parsed 5",
          category: "csv",
        },
        {
          line: 8,
          input: "Opt",
          message: "Expected a card name and a quantity between 1 and 250",
          category: "csv",
        },
        {
          line: 10,
          input: "Island",
          message: "Combined quantity exceeds 250",
          category: "csv",
        },
      ]);
    },
  );

  it.each(["\n", "\r\n"])(
    "maps CSV quote errors to the start line of the malformed record (%j)",
    (newline) => {
      const result = parseDecklist(
        [
          "Name,Quantity,Notes",
          "",
          "// Board: test",
          'Opt,1,"Unclosed',
          "note",
        ].join(newline),
      );
      expect(result.lines).toEqual([]);
      expect(result.issues).toEqual([
        {
          line: 4,
          input: "CSV row",
          message: "Quoted field unterminated",
          category: "csv",
        },
      ]);
    },
  );

  it.each([
    ["a board comment", "\n", ",", ["// Board: testing Pool"], "testing Pool"],
    [
      "comments and blank lines",
      "\r\n",
      ";",
      ["// Exported deck", "", "# notes", "// Board: testing Pool", ""],
      "testing Pool",
    ],
    ["a plain comment", "\n", ",", ["// Exported deck"], undefined],
  ])(
    "detects CSV after %s before the header and keeps physical lines",
    (_case, newline, delimiter, leading, board) => {
      const result = parseDecklist(
        [
          "",
          ...leading,
          `Name${delimiter}Quantity`,
          `Opt${delimiter}1`,
          `Shock${delimiter}invalid`,
        ].join(newline),
      );
      const header = leading.length + 2;
      expect(result.format).toBe("CSV");
      expect(result.entries).toEqual([
        expect.objectContaining({ name: "Opt", quantity: 1, board }),
      ]);
      expect(result.lines).toEqual([header + 1]);
      expect(result.issues).toEqual([
        {
          line: header + 2,
          input: "Shock",
          message: "Expected a card name and a quantity between 1 and 250",
          category: "csv",
        },
      ]);
    },
  );

  it.each([
    {
      name: "a CRLF board comment before LF rows",
      input:
        "\uFEFF// Board: Companions\r\nName,Quantity\nLurrus of the Dream-Den,1\nOpt,invalid",
      entries: [{ name: "Lurrus of the Dream-Den", zone: "companion" }],
      lines: [3],
      invalid: 4,
    },
    {
      name: "an indented board comment after another comment",
      input:
        "\uFEFF// Exported\n  // Board: Companions\nName,Quantity\nLurrus of the Dream-Den,1\nOpt,invalid",
      entries: [{ name: "Lurrus of the Dream-Den", zone: "companion" }],
      lines: [4],
      invalid: 5,
    },
    {
      name: "several leading comments with mixed endings",
      input:
        "\uFEFF\r\n# notes\r\n// Board: Sideboard\n\t// Board: Companions\r\n\r\nName;Quantity\r\nLurrus of the Dream-Den;1\r\nOpt;invalid\r\n// Board: testing Pool\r\nShock;1",
      entries: [
        { name: "Lurrus of the Dream-Den", zone: "companion" },
        { name: "Shock", zone: "main", board: "testing Pool" },
      ],
      lines: [7, 10],
      invalid: 8,
    },
  ])(
    "keeps boards and physical lines with $name",
    ({ input, entries, lines, invalid }) => {
      const result = parseDecklist(input);
      expect(result.format).toBe("CSV");
      expect(result.entries).toMatchObject(entries);
      expect(result.lines).toEqual(lines);
      expect(result.issues).toEqual([
        {
          line: invalid,
          input: "Opt",
          message: "Expected a card name and a quantity between 1 and 250",
          category: "csv",
        },
      ]);
    },
  );

  it.each([
    ["a plain header", "Name,Quantity,Board", ""],
    ["a quoted header", 'Name,Quantity,Board,"Notes;Name;Source"', ",x"],
  ])(
    "keeps quoted multiline Board values byte-for-byte with %s",
    (_case, header, extra) => {
      const result = parseDecklist(
        [
          "// Exported",
          header,
          'Opt,1,"Testing',
          `  // Board: notes"${extra}`,
          'Opt,2,"Testing',
          `// Board: notes"${extra}`,
        ].join("\n"),
      );
      expect(result.entries).toMatchObject([
        { name: "Opt", quantity: 1, board: "Testing\n  // Board: notes" },
        { name: "Opt", quantity: 2, board: "Testing\n// Board: notes" },
      ]);
      expect(result.lines).toEqual([3, 5]);
      expect(result.issues).toEqual([
        expect.objectContaining({
          line: 3,
          input: "Testing\n  // Board: notes",
        }),
        expect.objectContaining({ line: 5, input: "Testing\n// Board: notes" }),
      ]);
    },
  );

  it("reports CSV rows that produce no cards instead of an empty import", () => {
    const parse = Papa.parse;
    const spy = vi.spyOn(Papa, "parse").mockImplementationOnce(((
      input: string,
      config: Papa.ParseConfig<Record<string, string>>,
    ) => ({
      ...parse(input, config),
      data: [],
    })) as never);
    try {
      const result = parseDecklist("// Exported\nName,Quantity\nOpt,1");
      expect(result.entries).toEqual([]);
      expect(result.issues).toEqual([
        {
          line: 3,
          input: "CSV row",
          message: "No cards could be read from the CSV rows",
          category: "csv",
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps text lists that start with comments as Text / Arena", () => {
    const result = parseDecklist("// Exported deck\n# notes\n\n1 Opt\n2 Shock");
    expect(result.format).toBe("Text / Arena");
    expect(result.entries).toMatchObject([
      { name: "Opt", quantity: 1 },
      { name: "Shock", quantity: 2 },
    ]);
    expect(result.lines).toEqual([4, 5]);
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
