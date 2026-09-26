import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type DeckSummary } from "./api.ts";
import { deckSchema, type ImportLine } from "./core/index.ts";
import {
  attribution,
  DeckSearch,
  emptyMessage,
  groupByZone,
  searchableFormats,
} from "./deck-search.tsx";
import { ToolbarSlotProvider } from "./titlebar.tsx";

const summary: DeckSummary = {
  source: "archidekt",
  id: "3949764",
  name: "Atraxa Superfriends",
  format: "Commander",
  deckpressFormat: "Commander",
  author: "planeswalker",
  colorIdentity: ["W", "U", "B", "G"],
  cardCount: 100,
  updatedAt: "2025-05-01T10:00:00Z",
  url: "https://archidekt.com/decks/3949764",
  coverUrl: "",
  views: 1200,
};
const lines: ImportLine[] = [
  {
    quantity: 1,
    name: "Atraxa, Grand Unifier",
    zone: "commander",
    set: "mom",
    collectorNumber: "196",
  },
  { quantity: 1, name: "Sol Ring", zone: "main", set: "", collectorNumber: "" },
  {
    quantity: 4,
    name: "Command Tower",
    zone: "main",
    set: "",
    collectorNumber: "",
  },
  {
    quantity: 1,
    name: "Not A Card",
    zone: "maybe",
    set: "",
    collectorNumber: "",
  },
];

beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(
    function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  );
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute("open");
  });
});

it("groups decklist lines by zone in play order and skips empty zones", () => {
  const groups = groupByZone(lines);
  expect(groups.map((group) => group.zone)).toEqual([
    "commander",
    "main",
    "maybe",
  ]);
  expect(groups[1]).toMatchObject({ name: "Main deck", count: 5 });
  expect(groupByZone([])).toEqual([]);
});

it("writes empty-state copy that names the query and a next step", () => {
  expect(
    emptyMessage({
      text: " Atraxa ",
      field: "commander",
      format: "Modern",
      source: "archidekt",
    }),
  ).toBe(
    "No decks match “Atraxa” in Modern. Check the commander's spelling, or search any format.",
  );
  expect(
    emptyMessage({ text: "x", field: "name", format: "", source: null }),
  ).toContain("search by commander or card instead");
});

it("records the source and author in the imported deck's notes", () => {
  expect(attribution(summary)).toBe(
    "Imported from Archidekt by planeswalker: https://archidekt.com/decks/3949764",
  );
  expect(attribution({ ...summary, author: "" })).toBe(
    "Imported from Archidekt: https://archidekt.com/decks/3949764",
  );
  expect(searchableFormats).not.toContain("Cube");
});

it("searches after typing, previews the list, and imports only after showing unresolved lines", async () => {
  const user = userEvent.setup();
  const search = vi.spyOn(api, "searchDecks").mockResolvedValue({
    items: [summary],
    page: 1,
    hasMore: false,
    total: 1,
    matchedCard: null,
    cardMatches: [],
  });
  vi.spyOn(api, "deckDetail").mockResolvedValue({
    summary,
    description: "Proliferate everything.",
    lines,
  });
  vi.spyOn(api, "importExternalDeck").mockResolvedValue({
    entries: [],
    issues: [{ line: 4, input: "1 Not A Card", message: "Card not found" }],
  });
  const create = vi.spyOn(api, "createDeck");
  const open = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const slot = document.createElement("div");
  document.body.append(slot);
  render(
    <QueryClientProvider client={client}>
      <ToolbarSlotProvider value={slot}>
        <DeckSearch open={open} />
      </ToolbarSlotProvider>
    </QueryClientProvider>,
  );
  expect(screen.getByText("Find a deck to print")).toBeVisible();
  await user.selectOptions(screen.getByLabelText("Format"), "Commander");
  await user.type(
    screen.getByRole("searchbox", { name: /Search public decks/ }),
    "Atraxa",
  );
  await waitFor(() =>
    expect(search).toHaveBeenCalledWith(
      {
        text: "Atraxa",
        field: "name",
        format: "Commander",
        source: "archidekt",
      },
      1,
      expect.anything(),
    ),
  );
  await user.click(
    await screen.findByRole("button", { name: "Preview Atraxa Superfriends" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("Sol Ring")).toBeVisible();
  expect(within(dialog).getByText("Maybeboard")).toBeVisible();
  await user.click(
    within(dialog).getByRole("button", { name: "Import as new deck" }),
  );
  expect(await within(dialog).findByText("1 line needs review")).toBeVisible();
  expect(within(dialog).getByText("1 Not A Card")).toBeVisible();
  expect(create).not.toHaveBeenCalled();
  expect(
    within(dialog).getByRole("button", { name: "Import 0 resolved cards" }),
  ).toBeDisabled();
});

it("creates the deck and opens it when every line resolves", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "searchDecks").mockResolvedValue({
    items: [summary],
    page: 1,
    hasMore: false,
    total: 1,
    matchedCard: null,
    cardMatches: [],
  });
  vi.spyOn(api, "deckDetail").mockResolvedValue({
    summary,
    description: "",
    lines,
  });
  vi.spyOn(api, "importExternalDeck").mockResolvedValue({
    entries: [],
    issues: [],
  });
  const created = deckSchema.parse({
    id: "0b6e5b2e-7d4a-4c0c-9a5e-0f6c2b7a1d11",
    name: summary.name,
    format: "Commander",
    entries: [],
    printSettings: {},
    revision: 0,
    createdAt: "2025-05-01T10:00:00Z",
    updatedAt: "2025-05-01T10:00:00Z",
  });
  const create = vi.spyOn(api, "createDeck").mockResolvedValue(created);
  const open = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const slot = document.createElement("div");
  document.body.append(slot);
  render(
    <QueryClientProvider client={client}>
      <ToolbarSlotProvider value={slot}>
        <DeckSearch open={open} />
      </ToolbarSlotProvider>
    </QueryClientProvider>,
  );
  await user.type(
    screen.getByRole("searchbox", { name: /Search public decks/ }),
    "Atraxa",
  );
  await user.click(
    await screen.findByRole("button", { name: "Preview Atraxa Superfriends" }),
  );
  const dialog = await screen.findByRole("dialog");
  await user.click(
    await within(dialog).findByRole("button", { name: "Import as new deck" }),
  );
  await waitFor(() => expect(open).toHaveBeenCalledWith(created.id));
  expect(create).toHaveBeenCalledWith({
    name: "Atraxa Superfriends",
    format: "Commander",
    entries: [],
    notes: attribution(summary),
  });
});

it("offers the other card matches and the next page when a page is empty", async () => {
  const user = userEvent.setup();
  const search = vi.spyOn(api, "searchDecks").mockResolvedValue({
    items: [],
    page: 1,
    hasMore: true,
    total: 0,
    matchedCard: "Atraxa's Fall",
    cardMatches: ["Atraxa, Praetors' Voice"],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const slot = document.createElement("div");
  document.body.append(slot);
  render(
    <QueryClientProvider client={client}>
      <ToolbarSlotProvider value={slot}>
        <DeckSearch open={vi.fn()} />
      </ToolbarSlotProvider>
    </QueryClientProvider>,
  );
  await user.selectOptions(screen.getByLabelText("Search by"), "commander");
  await user.type(
    screen.getByRole("searchbox", { name: /Search public decks/ }),
    "Atraxa",
  );
  expect(await screen.findByText("No decks found")).toBeVisible();
  expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  await user.click(
    screen.getByRole("button", { name: "Atraxa, Praetors' Voice" }),
  );
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Atraxa, Praetors' Voice",
        field: "commander",
      }),
      1,
      expect.anything(),
    ),
  );
});
