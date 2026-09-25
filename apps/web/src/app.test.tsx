import {
  artSchema,
  type Deck,
  type DeckEntry,
  deckSchema,
  printSettingsSchema,
} from "@deckpress/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import { App } from "./app.tsx";
import { ArtPicker, filterArt } from "./art-picker.tsx";
import { PrintSetup } from "./print-setup.tsx";

const id = "a4f5c8d1-0903-40be-8f8c-e9dcb5aa7240";
const original = artSchema.parse({
  id: "scryfall:original",
  provider: "scryfall",
  name: "Lightning Bolt",
  imageUrl: "https://cards.scryfall.io/original.png",
  thumbnailUrl: "https://cards.scryfall.io/original.jpg",
  source: "Magic 2010",
  artist: "Christopher Moeller",
  set: "m10",
  collectorNumber: "146",
});
const alternate = artSchema.parse({
  ...original,
  id: "scryfall:alternate",
  imageUrl: "https://cards.scryfall.io/alternate.png",
  source: "Mystical Archive",
  artist: "Anato Finnstark",
  tags: ["showcase"],
  collectorNumber: "42",
  releasedAt: "2021-01-01",
});
const community = artSchema.parse({
  ...alternate,
  id: "mpc:custom",
  provider: "mpc",
  source: "Creator",
  artist: "Uncredited",
  dpi: 1200,
});
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
    faces: [original],
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

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
  vi.spyOn(api, "settings").mockResolvedValue({
    storage: "Local SQLite",
    localOnly: true,
    upscaler: {
      available: true,
      model: "4x_NMKD-Siax_200k",
      scale: 4,
      reason: "Configured",
    },
  });
});

it("creates a deck, imports resolved cards, and reopens the saved project", async () => {
  const user = userEvent.setup();
  let stored: Deck | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === "/api/health")
        return Response.json({ status: "ok", service: "@deckpress/api" });
      if (path === "/api/decks" && init?.method === "POST") {
        stored = { ...deck, entries: [] };
        return Response.json(stored);
      }
      if (path === "/api/decks") return Response.json(stored ? [stored] : []);
      if (path === `/api/decks/${id}` && init?.method === "PUT") {
        stored = deckSchema.parse(JSON.parse(String(init.body)));
        stored.revision++;
        return Response.json(stored);
      }
      if (path === `/api/decks/${id}`) return Response.json(stored);
      if (path === "/api/import")
        return Response.json({
          entries: [entry],
          issues: [],
          format: "Text / Arena",
        });
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
  renderWithClient(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Create your first deck" }),
  );
  await user.type(screen.getByLabelText("Deck name"), "Burn");
  await user.click(screen.getByRole("button", { name: "Create deck" }));
  await user.type(
    await screen.findByLabelText("Decklist"),
    "4 Lightning Bolt (M10) 146",
  );
  await user.click(screen.getByRole("button", { name: "Resolve on Scryfall" }));
  await user.click(
    await screen.findByRole("button", { name: "Add 4 cards to deck" }),
  );
  expect(
    await screen.findByRole("button", { name: "Imported and saved" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Back to decks" }));
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  expect(
    await screen.findByRole("button", {
      name: "Choose art for Lightning Bolt",
    }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

it("keeps the original scan while selecting art for one copy and saving a personal rating", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "art").mockImplementation(async (provider) => ({
    items: provider === "mpc" ? [community] : [original, alternate],
    page: 1,
    hasMore: false,
    total: 2,
  }));
  vi.spyOn(api, "uploads").mockResolvedValue([]);
  vi.spyOn(api, "preferences").mockResolvedValue({
    preferences: {},
    usage: {},
  });
  const preference = vi
    .spyOn(api, "savePreference")
    .mockImplementation(async (_, value) => value);
  const apply = vi.fn(async (value: Deck) => value);
  renderWithClient(
    <ArtPicker deck={deck} entry={entry} onSelect={vi.fn()} onApply={apply} />,
  );
  const originalImage = screen
    .getByAltText("Original: Lightning Bolt")
    .getAttribute("src");
  await user.click(
    await screen.findByRole("button", {
      name: "Select Mystical Archive 42 by Anato Finnstark",
    }),
  );
  expect(screen.getByAltText("Original: Lightning Bolt")).toHaveAttribute(
    "src",
    originalImage,
  );
  expect(screen.getByAltText("Selected: Lightning Bolt")).toHaveAttribute(
    "src",
    expect.stringContaining("alternate.png"),
  );
  await user.selectOptions(screen.getByLabelText("Your rating"), "5");
  await waitFor(() =>
    expect(preference).toHaveBeenCalledWith(
      alternate.id,
      expect.objectContaining({ rating: 5 }),
    ),
  );
  await user.selectOptions(screen.getByLabelText("Apply to"), "one");
  await user.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(apply).toHaveBeenCalledOnce());
  expect(
    apply.mock.calls[0]?.[0].entries.map((item) => [
      item.quantity,
      item.selectedArt?.id,
    ]),
  ).toEqual([
    [3, undefined],
    [1, alternate.id],
  ]);
});

it("intersects official provenance, labels and source resolution without inventing popularity", () => {
  const data = {
    preferences: {
      [alternate.id]: { rating: 5, favorite: true, tags: ["favorite deck"] },
    },
    usage: { [original.id]: 10 },
  };
  const options = {
    search: "",
    provider: "all",
    official: false,
    artist: "",
    tag: "",
    dpi: 0,
    favorites: false,
    sort: "popular",
  };
  expect(
    filterArt([original, alternate, community, original], options, data).map(
      (art) => art.id,
    ),
  ).toEqual([original.id, alternate.id, community.id]);
  expect(
    filterArt(
      [original, alternate, community],
      {
        ...options,
        official: true,
        provider: "mpc",
        tag: "favorite deck",
        favorites: true,
      },
      data,
    ),
  ).toEqual([alternate]);
  expect(
    filterArt(
      [original, alternate, community],
      { ...options, official: true, dpi: 600 },
      data,
    ),
  ).toEqual([]);
  expect(
    filterArt(
      [original, alternate, community],
      { ...options, artist: "Creator", dpi: 1200 },
      data,
    ),
  ).toEqual([community]);
});

it("blocks an impossible sheet and exports the saved settings after correction", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async (value: Deck) => value);
  const jobs = vi.fn();
  const createJob = vi.spyOn(api, "createJob").mockResolvedValue({
    id,
    deckId: id,
    deckName: "Burn",
    status: "queued",
    completed: 0,
    total: 4,
    message: "Queued",
    createdAt: deck.createdAt,
    fileName: "burn.pdf",
    bytes: 0,
    pages: 1,
  });
  function PrintHarness() {
    const [value, setValue] = useState({
      ...deck,
      printSettings: { ...deck.printSettings, columns: 10 },
    });
    return (
      <PrintSetup
        deck={value}
        onChange={setValue}
        onSave={save}
        onJobs={jobs}
      />
    );
  }
  renderWithClient(<PrintHarness />);
  expect(screen.getByRole("alert")).toHaveTextContent("Cards do not fit");
  for (const button of screen.getAllByRole("button", { name: "Generate PDF" }))
    expect(button).toBeDisabled();
  await user.selectOptions(screen.getByLabelText("Print preset"), "proof");
  expect(
    screen.getByRole("img", { name: /Print preview, A4, 3 columns by 3 rows/ }),
  ).toBeVisible();
  await user.click(
    screen.getAllByRole("button", { name: "Generate PDF" })[0] as HTMLElement,
  );
  await waitFor(() => expect(jobs).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      printSettings: expect.objectContaining({ dpi: 300, columns: 0 }),
    }),
  );
  expect(createJob).toHaveBeenCalledWith(
    id,
    expect.objectContaining({ dpi: 300, columns: 0 }),
  );
});

it("keeps a failed library request visible and lets the user retry", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "decks")
    .mockRejectedValueOnce(new Error("Local storage unavailable"))
    .mockResolvedValue([]);
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: "ok", service: "@deckpress/api" }),
      ),
  );
  renderWithClient(<App />);
  const error = await screen.findByRole("alert");
  expect(error).toHaveTextContent("Local storage unavailable");
  await user.click(within(error).getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: "Create your first deck" }),
  ).toBeVisible();
});
