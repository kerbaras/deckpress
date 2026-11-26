import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ImportResult } from "./api.ts";
import type { DeckEntry } from "./core/index.ts";
import { ImportPanel } from "./import-panel.tsx";

const refused =
  "Moxfield refused the request (HTTP 403): it blocks apps that are not a web browser. In Moxfield, open the deck, choose More › Download / Export, click Copy Plain Text and paste the list here.";
const url = "https://moxfield.com/decks/DYmpyOwmekecAkPnC3Tjsg";

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
function mockResolver() {
  mockIPC((cmd, args) => {
    if (cmd !== "resolve_cards") throw new Error(`Unexpected ${cmd}`);
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
  mockIPC((cmd) => {
    if (cmd !== "import_url") throw new Error(`Unexpected ${cmd}`);
    calls++;
    return Promise.reject(refused);
  });
  render(<ImportPanel existing={0} onApply={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "URL" }));
  await user.type(screen.getByLabelText("Public deck URL"), url);
  await user.click(screen.getByRole("button", { name: "Resolve on Scryfall" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("HTTP 403");
  expect(alert).toHaveTextContent("More › Download / Export");
  expect(alert).toHaveTextContent("Copy Plain Text");
  expect(screen.getByLabelText("Public deck URL")).toHaveValue(url);
  expect(screen.getByRole("button", { name: "Retry URL" })).toHaveFocus();

  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 403");
  expect(calls).toBe(2);
  expect(screen.getByRole("button", { name: "Retry URL" })).toHaveFocus();

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

it("reviews a partial list by line and board, then saves without moving focus", async () => {
  const user = userEvent.setup();
  mockResolver();
  const onApply =
    vi.fn<(result: ImportResult, replace: boolean) => Promise<void>>();
  onApply.mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue();
  render(<ImportPanel existing={10} onApply={onApply} />);
  await user.click(screen.getByLabelText("Decklist"));
  await user.paste(
    "Deck\n4 Shock\n2 Lightnig Bolt\n\nSideboard\n2 Negate\n1 Shock",
  );
  await user.click(screen.getByRole("button", { name: "Resolve on Scryfall" }));

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
  expect(await screen.findByText("Disk full")).toBeVisible();
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
