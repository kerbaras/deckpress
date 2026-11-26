import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { api, type ImportResult } from "./api.ts";
import type { DeckEntry } from "./core/index.ts";
import { ImportPanel } from "./import-panel.tsx";

const refused =
  "Moxfield refused the request (HTTP 403): it blocks apps that are not a web browser. In Moxfield, open the deck, choose More › Download / Export, click Copy Plain Text and paste the list here.";
const url = "https://moxfield.com/decks/DYmpyOwmekecAkPnC3Tjsg";

it.each(["companions", "COMPANION", "Com–panions："])(
  "does not send the standalone CSV heading %s or other malformed rows to the resolver",
  async (heading) => {
    const resolve = vi.fn().mockReturnValue({
      entries: [],
      issues: [{ line: 3, input: "1 Typo", message: "Not found" }],
    });
    mockIPC((cmd, args) => {
      if (cmd !== "resolve_cards") throw new Error(`Unexpected ${cmd}`);
      return resolve(args);
    });
    const result = await api.import({
      text: [
        "Name,Quantity,Board,Notes",
        "",
        "// Board: testing Pool",
        'Opt,1,Sideboard,"Multiline',
        'note"',
        heading,
        "Negate,1,Board,",
        "Typo,1,,",
        "Island,1,,,extra",
        "Forest",
        "Spirited Companion,1,Companions,",
        'Plains,1,,"Unterminated',
      ].join("\r\n"),
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      lines: [
        expect.objectContaining({ name: "Opt", zone: "side" }),
        expect.objectContaining({ name: "Negate", zone: "main" }),
        expect.objectContaining({ name: "Typo" }),
        expect.objectContaining({ name: "Spirited Companion", zone: "main" }),
      ],
    });
    expect(result.issues.map(({ line }) => line)).toEqual([
      6, 7, 8, 9, 10, 11, 12,
    ]);
  },
);

const card = (name: string, quantity: number, zone: DeckEntry["zone"]) => {
  const id = crypto.randomUUID();
  return {
    id,
    card: {
      id,
      oracleId: id,
      name,
      typeLine: "Instant",
      manaCost: "{R}",
      manaValue: 1,
      colors: ["R"],
      faces: [
        {
          id: `scryfall:${id}`,
          provider: "scryfall",
          name,
          imageUrl: "https://cards.scryfall.io/a.png",
          thumbnailUrl: "https://cards.scryfall.io/a.jpg",
          source: "Magic 2010",
          artist: "Artist",
        },
      ],
    },
    quantity,
    zone,
    excluded: false,
    selectedArt: null,
    selectedBack: null,
  };
};

/** Resolves every line except "Lightnig Bolt", which Scryfall reports by position. */
function mockResolver(beforeResolve?: Promise<void>) {
  mockIPC(async (cmd, args) => {
    if (cmd !== "resolve_cards") throw new Error(`Unexpected ${cmd}`);
    await beforeResolve;
    const lines = (
      args as {
        lines: { name: string; quantity: number; zone: DeckEntry["zone"] }[];
      }
    ).lines;
    const entries = [];
    const issues = [];
    for (const [index, line] of lines.entries()) {
      if (line.name === "Lightnig Bolt")
        issues.push({
          line: index + 1,
          input: `${line.quantity} ${line.name}`,
          message: "Exact card or printing not found.",
        });
      else entries.push(card(line.name, line.quantity, line.zone));
    }
    return { entries, issues };
  });
}

it("offers the paste fallback and a retry when a deck URL is refused", async () => {
  const user = userEvent.setup();
  let calls = 0;
  const rejection = Promise.withResolvers<never>();
  mockIPC((cmd) => {
    if (cmd !== "import_url") throw new Error(`Unexpected ${cmd}`);
    calls++;
    return rejection.promise;
  });
  render(<ImportPanel existing={0} onApply={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "URL" }));
  expect(
    screen.getByText(
      /if Moxfield blocks the import, open the deck in your browser/i,
    ),
  ).toHaveTextContent(
    "More › Download / Export › Copy Plain Text. Then paste the list into the Paste tab.",
  );
  await user.type(screen.getByLabelText("Public deck URL"), url);
  const status = screen.getByRole("status");
  await user.click(screen.getByRole("button", { name: "Resolve on Scryfall" }));
  expect(status).toHaveTextContent("Resolving cards…");
  rejection.reject(refused);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("HTTP 403");
  expect(alert).toHaveTextContent("More › Download / Export");
  expect(alert).toHaveTextContent("Copy Plain Text");
  expect(status).toBeEmptyDOMElement();
  expect(screen.getByLabelText("Public deck URL")).toHaveValue(url);
  expect(screen.getByRole("button", { name: "Retry URL" })).toHaveFocus();

  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 403");
  expect(calls).toBe(2);
  const urlInput = screen.getByLabelText("Public deck URL");
  await waitFor(() => {
    expect(urlInput).toBeEnabled();
    expect(urlInput).toHaveFocus();
  });
  expect(urlInput).toHaveValue(url);

  await user.click(screen.getByRole("button", { name: "Paste exported list" }));
  expect(screen.getByRole("button", { name: "Paste" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Decklist")).toHaveFocus();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "URL" }));
  expect(screen.getByLabelText("Public deck URL")).toHaveValue(url);
});

it("announces resolving and saving one card", async () => {
  const user = userEvent.setup();
  mockResolver();
  render(
    <ImportPanel existing={0} onApply={vi.fn().mockResolvedValue(undefined)} />,
  );
  await user.type(screen.getByLabelText("Decklist"), "1 Shock");
  await user.click(screen.getByRole("button", { name: "Resolve on Scryfall" }));
  const add = await screen.findByRole("button", { name: "Add 1 card to deck" });
  expect(screen.getByRole("status")).toHaveTextContent("1 card resolved.");
  expect(screen.getByText("Add saves 1 card to this deck.")).toBeVisible();
  await user.click(add);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved 1 card to this deck.",
    ),
  );
});

it("reviews a partial list by line and board, then saves without moving focus", async () => {
  const user = userEvent.setup();
  const resolution = Promise.withResolvers<void>();
  const saving = Promise.withResolvers<void>();
  mockResolver(resolution.promise);
  const onApply =
    vi.fn<(result: ImportResult, replace: boolean) => Promise<void>>();
  onApply.mockReturnValueOnce(saving.promise).mockResolvedValue();
  render(<ImportPanel existing={10} onApply={onApply} />);
  const status = screen.getByRole("status");
  await user.click(screen.getByLabelText("Decklist"));
  await user.paste(
    "Deck\n4 Shock\n2 Lightnig Bolt\n\nSideboard\n2 Negate\n1 Shock",
  );
  await user.click(screen.getByRole("button", { name: "Resolve on Scryfall" }));
  expect(status).toHaveTextContent("Resolving cards…");
  resolution.resolve();

  expect(
    await screen.findByRole("heading", { name: "7 cards resolved" }),
  ).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent(
    "7 cards resolved. 1 line needs review.",
  );

  const boards = await screen.findByRole("list", {
    name: "Resolved cards by board",
  });
  expect(within(boards).getByText("Mainboard").nextSibling).toHaveTextContent(
    "4",
  );
  expect(within(boards).getByText("Sideboard").nextSibling).toHaveTextContent(
    "3",
  );
  expect(screen.getByText("7 cards resolved")).toBeVisible();
  const unresolved = screen.getByRole("list", { name: "Unresolved lines" });
  expect(within(unresolved).getByRole("listitem")).toHaveTextContent("Line 3");
  expect(within(unresolved).getByRole("listitem")).toHaveTextContent(
    "2 Lightnig Bolt",
  );
  expect(
    screen.getByText(
      "Add saves these 7 cards alongside the 10 cards already in this deck.",
    ),
  ).toBeVisible();

  await user.click(
    screen.getByLabelText("Replace current list, keeping matching art choices"),
  );
  expect(
    screen.getByText(
      /Replace removes the 10 cards in this deck and saves these 7 cards/,
    ),
  ).toBeVisible();
  const action = screen.getByRole("button", {
    name: "Replace list with 7 cards",
  });

  await user.click(action);
  expect(status).toHaveTextContent("Saving imported cards…");
  saving.reject(new Error("Disk full"));
  expect(await screen.findByText("Disk full")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("Disk full");
  expect(status).toBeEmptyDOMElement();
  expect(onApply).toHaveBeenLastCalledWith(
    expect.objectContaining({ format: "Text / Arena" }),
    true,
  );
  expect(action).toBeEnabled();
  expect(action).toHaveTextContent("Replace list with 7 cards");
  expect(screen.getByRole("list", { name: "Unresolved lines" })).toBeVisible();

  await user.click(action);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Saved 7 cards to this deck.",
  );
  expect(action).toHaveFocus();
  expect(action).toHaveTextContent("Imported and saved");
  expect(action).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByText(/Replace removes/)).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText(/Replace current list/),
  ).not.toBeInTheDocument();
  await user.click(action);
  expect(onApply).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "shows board warnings separately from unresolved lines (mixed: %s)",
  async (mixed) => {
    const user = userEvent.setup();
    const onApply = vi
      .fn<(result: ImportResult, replace: boolean) => Promise<void>>()
      .mockResolvedValue();
    mockResolver();
    render(<ImportPanel existing={0} onApply={onApply} />);
    const status = screen.getByRole("status");
    await user.click(screen.getByLabelText("Decklist"));
    await user.paste(
      `Name,Quantity,Board\n\n// Board: Custom\nNegate,1,testing Pool${mixed ? "\nLightnig Bolt,1,Deck" : ""}`,
    );
    await user.click(
      screen.getByRole("button", { name: "Resolve on Scryfall" }),
    );

    const warnings = await screen.findByRole("list", {
      name: "Imported with warnings",
    });
    expect(warnings).toBeVisible();
    expect(warnings).toHaveTextContent("Line 4");
    expect(warnings).toHaveTextContent("testing Pool");
    expect(warnings).toHaveTextContent(
      "Unrecognized board; imported to Mainboard",
    );
    expect(
      screen.getByRole("heading", { name: "1 card resolved" }),
    ).toHaveFocus();
    expect(status).toHaveTextContent(
      `1 card resolved. ${mixed ? "1 line needs" : "No lines need"} review. 1 warning.`,
    );
    const unresolved = screen.queryByRole("list", { name: "Unresolved lines" });
    const guidance = screen.queryByText(
      /correct these lines and resolve again/i,
    );
    if (mixed) {
      expect(unresolved).toHaveTextContent("1 Lightnig Bolt");
      expect(unresolved).not.toHaveTextContent("testing Pool");
      expect(guidance).toBeVisible();
    } else {
      expect(unresolved).not.toBeInTheDocument();
      expect(guidance).not.toBeInTheDocument();
    }

    await user.click(
      screen.getByRole("button", { name: "Add 1 card to deck" }),
    );
    expect(status).toHaveTextContent("Saved 1 card to this deck.");
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            card: expect.objectContaining({ name: "Negate" }),
            zone: "main",
          }),
        ],
      }),
      false,
    );
  },
);

it("keeps the save action disabled when no cards resolve", async () => {
  const user = userEvent.setup();
  mockResolver();
  render(<ImportPanel existing={0} onApply={vi.fn()} />);
  await user.click(screen.getByLabelText("Decklist"));
  await user.paste("// my list\n2 Lightnig Bolt");
  await user.click(screen.getByRole("button", { name: "Resolve on Scryfall" }));
  expect(await screen.findByText("0 cards resolved")).toBeVisible();
  expect(screen.getByText(/Line 2/)).toBeVisible();
  expect(screen.getByText(/nothing to save/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Add 0 cards to deck" }),
  ).toBeDisabled();
});

it("announces a new resolution after a previous save failed", async () => {
  const user = userEvent.setup();
  mockResolver();
  render(
    <ImportPanel
      existing={0}
      onApply={vi.fn().mockRejectedValue(new Error("Disk full"))}
    />,
  );
  const resolve = screen.getByRole("button", { name: "Resolve on Scryfall" });
  await user.click(screen.getByLabelText("Decklist"));
  await user.paste("2 Shock");
  await user.click(resolve);
  await user.click(
    await screen.findByRole("button", { name: "Add 2 cards to deck" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");

  await user.click(resolve);
  expect(
    await screen.findByRole("heading", { name: "2 cards resolved" }),
  ).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent(
    "2 cards resolved. No lines need review.",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps the import status region rendered before it has anything to say", async () => {
  const user = userEvent.setup();
  mockResolver();
  const style = document.createElement("style");
  style.textContent = readFileSync(
    join(import.meta.dirname, "styles.css"),
    "utf8",
  );
  document.head.append(style);
  try {
    render(
      <ImportPanel
        existing={0}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(status).toBeVisible();

    await user.click(screen.getByLabelText("Decklist"));
    await user.paste("2 Shock");
    await user.click(
      screen.getByRole("button", { name: "Resolve on Scryfall" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add 2 cards to deck" }),
    );
    expect(status).toHaveTextContent("Saved 2 cards to this deck.");
    expect(status).toBeVisible();
    expect(screen.getByRole("status")).toBe(status);
  } finally {
    style.remove();
  }
});

it("keeps a focused Workspace file control in view on resize", async () => {
  const user = userEvent.setup();
  render(
    <>
      <button type="button">Outside the import panel</button>
      <ImportPanel existing={0} onApply={vi.fn()} />
    </>,
  );
  await user.click(screen.getByRole("button", { name: "File" }));
  const picker = screen.getByLabelText(/Choose a decklist/);
  const scrollIntoView = vi.fn();
  Object.defineProperty(picker, "scrollIntoView", { value: scrollIntoView });
  picker.focus();

  window.dispatchEvent(new Event("resize"));
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  expect(picker).toHaveFocus();

  screen.getByRole("button", { name: "Outside the import panel" }).focus();
  window.dispatchEvent(new Event("resize"));
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
});

it("shows the loaded filename independently of the reusable picker", async () => {
  const user = userEvent.setup();
  render(<ImportPanel existing={0} onApply={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "File" }));
  const picker = screen.getByLabelText(/Choose a decklist/);
  const decklist = screen.getByLabelText("Decklist");
  const file = new File(["4 Shock"], "burn.txt");

  await user.upload(picker, file);
  expect(await screen.findByText("Loaded file: burn.txt")).toBeVisible();
  expect(picker).toHaveAccessibleDescription("Loaded file: burn.txt");
  expect(picker).toHaveValue("");
  expect(decklist).toHaveValue("4 Shock");

  await user.clear(decklist);
  expect(screen.queryByText("Loaded file: burn.txt")).not.toBeInTheDocument();

  await user.upload(picker, file);
  expect(await screen.findByText("Loaded file: burn.txt")).toBeVisible();
  expect(decklist).toHaveValue("4 Shock");

  await user.upload(picker, new File(["x".repeat(200_001)], "large.txt"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Decklist exceeds 200 KB",
  );
  expect(screen.queryByText(/Loaded file:/)).not.toBeInTheDocument();
  expect(decklist).toHaveValue("4 Shock");
});
