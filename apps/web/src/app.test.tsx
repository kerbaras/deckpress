import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import { App } from "./app.tsx";
import { ArtPicker, filterArt } from "./art-picker.tsx";
import {
  artSchema,
  type Deck,
  type DeckEntry,
  deckSchema,
  printSettingsSchema,
} from "./core/index.ts";
import { PrintSetup } from "./print-setup.tsx";
import { applyPicks, targetsFor } from "./style-match.tsx";

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
const compactModel = {
  id: "realesr-general-x4v3",
  name: "Real-ESRGAN general x4v3 (compact)",
  tier: "default" as const,
  kind: "upscale" as const,
  file: "realesr-general-x4v3-dn50-256.fp16.onnx",
  scale: 4,
  tile: 256,
  bytes: 2444090,
  sha256: "ce83",
  bundled: true,
  url: null,
  license: "BSD-3-Clause",
  licenseUrl: "https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE",
  source: "https://github.com/xinntao/Real-ESRGAN",
  description: "Compact SRVGG network.",
  installed: true,
  downloading: false,
};
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
    models: [compactModel],
    defaultModel: compactModel.id,
    loaded: null,
    storage: "Local SQLite",
    localOnly: true,
    dataDir: "/tmp/deckpress",
    styleModel: null,
  });
});

it("creates a deck, imports resolved cards, and reopens the saved project", async () => {
  const user = userEvent.setup();
  let stored: Deck | null = null;
  const lines: unknown[] = [];
  mockIPC((cmd, args) => {
    switch (cmd) {
      case "health":
        return { status: "ok", service: "@deckpress/desktop" };
      case "create_deck":
        stored = { ...deck, entries: [] };
        return stored;
      case "list_decks":
        return stored ? [stored] : [];
      case "save_deck": {
        stored = deckSchema.parse((args as { deck: unknown }).deck);
        stored.revision++;
        return stored;
      }
      case "get_deck":
        return stored;
      case "resolve_cards":
        lines.push(...(args as { lines: unknown[] }).lines);
        return { entries: [entry], issues: [] };
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
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
  expect(lines).toEqual([
    expect.objectContaining({
      name: "Lightning Bolt",
      quantity: 4,
      set: "m10",
      collectorNumber: "146",
    }),
  ]);
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

it("ranks the other cards against a reference art and only applies the picks the user keeps", async () => {
  const user = userEvent.setup();
  const boltId = "b4f5c8d1-0903-40be-8f8c-e9dcb5aa7241";
  const bolt = artSchema.parse({
    ...original,
    id: "scryfall:bolt-m11",
    name: "Fireblast",
    imageUrl: "https://cards.scryfall.io/bolt.png",
  });
  const boltShowcase = artSchema.parse({
    ...alternate,
    id: "scryfall:bolt-showcase",
    name: "Fireblast",
  });
  const other: DeckEntry = {
    ...entry,
    id: boltId,
    card: {
      ...entry.card,
      id: boltId,
      oracleId: boltId,
      name: "Fireblast",
      faces: [bolt],
    },
    quantity: 2,
  };
  const spellId = "c4f5c8d1-0903-40be-8f8c-e9dcb5aa7242";
  const spell = artSchema.parse({
    ...original,
    id: "scryfall:spell",
    name: "Shock",
  });
  const third: DeckEntry = {
    ...entry,
    id: spellId,
    card: {
      ...entry.card,
      id: spellId,
      oracleId: spellId,
      name: "Shock",
      faces: [spell],
    },
    quantity: 1,
  };
  const full: Deck = { ...deck, entries: [entry, other, third] };
  expect(targetsFor(full, entry).map((item) => item.id)).toEqual([
    boltId,
    spellId,
  ]);

  vi.spyOn(api, "art").mockImplementation(async (provider, oracleId) => ({
    items:
      provider !== "scryfall"
        ? [community]
        : oracleId === boltId
          ? [bolt, boltShowcase]
          : oracleId === spellId
            ? [spell]
            : [original, alternate],
    page: 1,
    hasMore: false,
    total: 2,
  }));
  vi.spyOn(api, "uploads").mockResolvedValue([]);
  vi.spyOn(api, "preferences").mockResolvedValue({
    preferences: {},
    usage: {},
  });
  vi.spyOn(api, "settings").mockResolvedValue({
    models: [compactModel],
    defaultModel: compactModel.id,
    loaded: null,
    storage: "Local SQLite",
    localOnly: true,
    dataDir: "/tmp/deckpress",
    styleModel: {
      ...compactModel,
      tier: "style" as const,
      kind: "styleEmbedding" as const,
    },
  });
  const match = vi
    .spyOn(api, "matchArtStyle")
    .mockImplementation(async (request, onProgress) => {
      onProgress?.({ done: 1, total: 3 });
      return {
        method: "heuristic",
        model: null,
        warnings: [
          "Art-style model could not be loaded; ranking by metadata only",
        ],
        embedded: 0,
        skipped: 0,
        matches: request.entries.map((item) => ({
          entryId: item.entryId,
          ranked: [...item.options]
            .sort(
              (a, b) =>
                Number(b.tags.includes("showcase")) -
                Number(a.tags.includes("showcase")),
            )
            .map((art) => ({
              art,
              score: art.tags.includes("showcase") ? 0.9 : 0.2,
              visual: null,
              metadata: art.tags.includes("showcase") ? 0.9 : 0.2,
              reasons: art.tags.includes("showcase")
                ? ["Same artist", "Shared label: showcase"]
                : [],
            })),
        })),
      };
    });
  const apply = vi.fn(async (value: Deck) => value);
  renderWithClient(
    <ArtPicker deck={full} entry={entry} onSelect={vi.fn()} onApply={apply} />,
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Select Mystical Archive 42 by Anato Finnstark",
    }),
  );
  await user.click(screen.getByRole("button", { name: /Match art style/ }));
  const dialog = screen.getByRole("dialog", { name: "Match art style" });
  expect(within(dialog).getByText(/other 2 cards/)).toBeVisible();
  await user.click(
    within(dialog).getByRole("button", { name: "Find matches" }),
  );
  expect(await within(dialog).findByText("Metadata only")).toBeVisible();
  expect(match).toHaveBeenCalledWith(
    expect.objectContaining({
      reference: alternate,
      useModel: true,
      entries: [
        { entryId: boltId, options: [bolt, boltShowcase] },
        { entryId: spellId, options: [spell] },
      ],
    }),
    expect.any(Function),
  );
  expect(within(dialog).getByText(/could not be loaded/)).toBeVisible();
  expect(within(dialog).getByText("1 of 2 cards will change")).toBeVisible();
  const shock = within(dialog).getByRole("group", {
    name: "Printing for Shock",
  });
  expect(within(shock).getByText("No other printings")).toBeVisible();
  const fireblast = within(dialog).getByRole("group", {
    name: "Printing for Fireblast",
  });
  expect(
    within(fireblast).getByRole("button", {
      name: "Use Mystical Archive 42 by Anato Finnstark",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await user.click(within(fireblast).getByRole("button", { name: "Keep" }));
  expect(within(dialog).getByText("No changes selected")).toBeVisible();
  expect(within(dialog).getByRole("button", { name: /Apply/ })).toBeDisabled();
  await user.click(
    within(fireblast).getByRole("button", {
      name: "Use Mystical Archive 42 by Anato Finnstark",
    }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Apply 1 changes" }),
  );
  await waitFor(() => expect(apply).toHaveBeenCalledOnce());
  expect(
    apply.mock.calls[0]?.[0].entries.map((item) => [
      item.id,
      item.selectedArt?.id,
    ]),
  ).toEqual([
    [id, undefined],
    [boltId, boltShowcase.id],
    [spellId, undefined],
  ]);
  expect(
    applyPicks(full, { [boltId]: bolt }).entries[1]?.selectedArt,
  ).toBeNull();
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
  mockIPC(() => ({ status: "ok", service: "@deckpress/desktop" }));
  renderWithClient(<App />);
  const error = await screen.findByRole("alert");
  expect(error).toHaveTextContent("Local storage unavailable");
  await user.click(within(error).getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: "Create your first deck" }),
  ).toBeVisible();
});
