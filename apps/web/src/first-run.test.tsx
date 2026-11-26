import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import { App } from "./app.tsx";
import {
  artSchema,
  type Deck,
  type DeckEntry,
  deckSchema,
  printSettingsSchema,
} from "./core/index.ts";

const id = "a4f5c8d1-0903-40be-8f8c-e9dcb5aa7240";
const entry: DeckEntry = {
  id,
  card: {
    id,
    oracleId: id,
    name: "Lightning Bolt",
    typeLine: "Instant",
    manaCost: "{R}",
    manaValue: 1,
    colors: ["R"],
    faces: [
      artSchema.parse({
        id: "scryfall:bolt",
        provider: "scryfall",
        name: "Lightning Bolt",
        imageUrl: "https://cards.scryfall.io/bolt.png",
        thumbnailUrl: "https://cards.scryfall.io/bolt.jpg",
        source: "Magic 2010",
      }),
    ],
  },
  quantity: 4,
  zone: "main",
  excluded: false,
  selectedArt: null,
  selectedBack: null,
};
const deck: Deck = {
  id,
  name: "Burn",
  format: "Modern",
  notes: "",
  entries: [entry],
  coverEntryId: "",
  revision: 0,
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
  printSettings: printSettingsSchema.parse({}),
};

const renderApp = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <App />
    </QueryClientProvider>,
  );

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  mockIPC(() => ({ status: "ok", service: "@deckpress/desktop" }));
});

it("offers import, build, an empty deck and samples on first run", async () => {
  vi.spyOn(api, "decks").mockResolvedValue([]);
  renderApp();
  const start = await screen.findByRole("region", {
    name: "Start your first deck",
  });
  expect(
    within(start).getByRole("button", { name: "Import a list" }),
  ).toHaveAccessibleDescription(/Paste text, choose a file, or link/);
  expect(
    within(start).getByRole("button", { name: "Build a deck" }),
  ).toBeVisible();
  expect(
    within(start).getByRole("button", { name: "Start an empty deck" }),
  ).toBeVisible();
  expect(start).toHaveTextContent("stay on this machine");
  expect(start).toHaveTextContent(
    "Samples and imports look up card data and images online",
  );
  expect(screen.getAllByRole("button", { name: /Use sample/ })).toHaveLength(3);
  expect(screen.queryByRole("combobox", { name: "Sort decks" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Tile view" })).toBeNull();
});

it("keeps the normal library for returning users", async () => {
  vi.spyOn(api, "decks").mockResolvedValue([deck]);
  renderApp();
  expect(
    await screen.findByRole("button", { name: "Open Burn" }),
  ).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Sort decks" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Import a list" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Use sample/ })).toBeNull();
});

it("enters the same guided builder as the sidebar", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "decks").mockResolvedValue([]);
  renderApp();
  await user.click(await screen.findByRole("button", { name: "Build a deck" }));
  await waitFor(() => expect(window.location.hash).toBe("#/builder"));
  expect(
    screen.getByRole("button", { name: "Deck builder", hidden: true }),
  ).toHaveAttribute("aria-current", "page");
});

it("cancelling an import leaves no deck behind", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "decks").mockResolvedValue([]);
  vi.spyOn(api, "import").mockResolvedValue({
    entries: [entry],
    issues: [],
    format: "Plain text",
  });
  const create = vi.spyOn(api, "createDeck");
  renderApp();
  await user.click(
    await screen.findByRole("button", { name: "Import a list" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import a list" });
  for (const mode of ["Paste", "File", "URL"])
    expect(within(dialog).getByRole("button", { name: mode })).toBeVisible();
  await user.type(within(dialog).getByLabelText("Deck name"), "Burn");
  await user.type(
    within(dialog).getByLabelText("Decklist"),
    "4 Lightning Bolt (M10) 146",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Resolve on Scryfall" }),
  );
  await within(dialog).findByRole("button", { name: "Add 4 cards to deck" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(create).not.toHaveBeenCalled();
  expect(
    screen.getByRole("region", { name: "Start your first deck" }),
  ).toBeVisible();
});

it("saves an imported list with the chosen name and format", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "decks").mockResolvedValue([]);
  vi.spyOn(api, "import").mockResolvedValue({
    entries: [entry],
    issues: [],
    format: "Plain text",
  });
  vi.spyOn(api, "deck").mockResolvedValue(deck);
  const create = vi.spyOn(api, "createDeck").mockResolvedValue(deck);
  renderApp();
  const announcement = screen.getByRole("status", {
    name: "Import announcements",
  });
  expect(announcement).toBeEmptyDOMElement();
  await user.click(
    await screen.findByRole("button", { name: "Import a list" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Import a list" });
  await user.type(
    within(dialog).getByLabelText("Decklist"),
    "4 Lightning Bolt (M10) 146",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Resolve on Scryfall" }),
  );
  const add = await within(dialog).findByRole("button", {
    name: "Add 4 cards to deck",
  });
  await user.click(add);
  const nameError = await within(dialog).findByRole("alert");
  expect(nameError).toHaveTextContent("Name the deck before adding the cards.");
  const nameField = within(dialog).getByLabelText("Deck name");
  expect(nameField).toHaveFocus();
  expect(nameField).toHaveAttribute("aria-invalid", "true");
  expect(nameField).toHaveAccessibleDescription(
    "Name the deck before adding the cards.",
  );
  expect(create).not.toHaveBeenCalled();
  expect(announcement).toBeEmptyDOMElement();
  await user.type(nameField, " Burn ");
  expect(nameError).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(nameField).not.toHaveAttribute("aria-invalid");
  await user.selectOptions(within(dialog).getByLabelText("Format"), "Modern");
  await user.click(add);
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      name: "Burn",
      format: "Modern",
      entries: [entry],
    }),
  );
  await waitFor(() => expect(window.location.hash).toBe(`#/decks/${id}`));
  const heading = await screen.findByRole("heading", {
    name: "Burn",
    level: 1,
  });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(
    await screen.findByRole("button", { name: "Back to decks" }),
  ).toBeVisible();
  expect(dialog).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Import announcements" })).toBe(
    announcement,
  );
  expect(announcement).toHaveTextContent("Saved 4 cards to this deck.");
});

it("keeps the focused Add button in view when the import dialog resizes", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "decks").mockResolvedValue([]);
  vi.spyOn(api, "import").mockResolvedValue({
    entries: [entry],
    issues: [],
    format: "Plain text",
  });
  renderApp();
  await user.click(
    await screen.findByRole("button", { name: "Import a list" }),
  );
  const dialog = within(screen.getByRole("dialog", { name: "Import a list" }));
  await user.type(dialog.getByLabelText("Decklist"), "4 Lightning Bolt");
  await user.click(dialog.getByRole("button", { name: "Resolve on Scryfall" }));
  const add = await dialog.findByRole("button", {
    name: "Add 4 cards to deck",
  });
  const scrollIntoView = vi.fn();
  Object.defineProperty(add, "scrollIntoView", { value: scrollIntoView });
  add.focus();

  window.dispatchEvent(new Event("resize"));
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  expect(add).toHaveFocus();
});

it("shows the skipped printing on the saved deck after a first-run Strict import", async () => {
  const user = userEvent.setup();
  const localized = {
    ...entry,
    requestedLanguages: ["es"],
    card: {
      ...entry.card,
      faces: entry.card.faces.map((face) => ({ ...face, language: "es" })),
    },
  };
  const missingPrints = [{ input: "1 Black Lotus", languages: ["es"] }];
  let saved: Deck | undefined;
  mockIPC((cmd, args) => {
    switch (cmd) {
      case "health":
        return { status: "ok", service: "@deckpress/desktop" };
      case "list_decks":
        return saved ? [saved] : [];
      case "resolve_cards":
        return {
          entries: [localized],
          issues: [
            {
              line: 2,
              input: "1 Black Lotus",
              kind: "noUsableScan",
              message: "No usable scan found in es.",
              printLookup: {
                set: "lea",
                collectorNumber: "232",
                languages: ["es"],
              },
            },
          ],
          missingPrints,
        };
      case "create_deck":
        saved = deckSchema.parse({
          ...deck,
          ...(args as { deck: object }).deck,
        });
        return saved;
      case "get_deck":
        return saved;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  renderApp();
  await user.click(
    await screen.findByRole("button", { name: "Import a list" }),
  );
  const dialog = within(screen.getByRole("dialog", { name: "Import a list" }));
  await user.type(dialog.getByLabelText("Deck name"), "Spanish Burn");
  await user.type(
    dialog.getByLabelText("Decklist"),
    "4 Lightning Bolt{enter}1 Black Lotus",
  );
  await user.click(dialog.getByRole("button", { name: "Resolve on Scryfall" }));
  expect(await dialog.findByText("No usable Spanish scan.")).toBeVisible();
  await user.click(dialog.getByRole("button", { name: "Add 4 cards to deck" }));
  expect(
    await screen.findByText("Not imported (last import): 1 Black Lotus"),
  ).toBeVisible();
  expect(saved?.missingPrints).toEqual(missingPrints);
  expect(saved?.entries).toHaveLength(1);
  expect(saved?.entries[0]?.requestedLanguages).toEqual(["es"]);
});
