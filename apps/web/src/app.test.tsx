import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emit, TauriEvent } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import legacyBackup from "../../../packages/core/tests/fixtures/deck-backup-before-board-names.json";
import printPageCounts from "../../../packages/core/tests/fixtures/print-page-counts.json";
import { api, imageSrc, type StyleReport, uploadTrimSrc } from "./api.ts";
import { App } from "./app.tsx";
import { ArtPicker, filterArt } from "./art-picker.tsx";
import {
  artSchema,
  type Deck,
  type DeckEntry,
  deckSchema,
  type PrintJob,
  printSettingsSchema,
} from "./core/index.ts";
import { ImportReview } from "./import-review.tsx";
import { PrintSetup } from "./print-setup.tsx";
import { showThemedWindow } from "./startup-window.ts";
import {
  applyPicks,
  collectOptions,
  optionsKey,
  StyleMatch,
  targetsFor,
} from "./style-match.tsx";
import { UpscaleComparison } from "./upscale-comparison.tsx";

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

/** Stands in for the Rust `export_file_name` command. */
const exportFileName = (args: unknown) => {
  const { deckName, suffix } = args as { deckName: string; suffix: string };
  return `${deckName}${suffix}`;
};

function renderWithClient(
  ui: ReactNode,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  }),
) {
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

it("announces library opening in the status mounted by the app shell", async () => {
  const sidebarPreference = window.localStorage.getItem("deckpress.sidebar");
  vi.useFakeTimers();
  try {
    window.history.replaceState(null, "", "/");
    const decks =
      Promise.withResolvers<Awaited<ReturnType<typeof api.decks>>>();
    vi.spyOn(api, "decks").mockReturnValue(decks.promise);
    renderWithClient(<App />);
    const getStatus = () =>
      screen.getByRole("status", { name: "Library loading" });
    const status = getStatus();
    expect(status).toBeEmptyDOMElement();
    expect(screen.getByText("Opening your library…")).toBeVisible();

    await act(() => vi.advanceTimersByTimeAsync(40));
    const message = within(status).getByRole("group");
    expect(message).toHaveTextContent("Opening your library…");
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    expect(within(status).getByRole("group")).toBe(message);

    await act(async () => {
      decks.resolve([deck]);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getStatus()).toBe(status);
    expect(status).toBeEmptyDOMElement();
    expect(screen.getByText(deck.name, { selector: "h2" })).toBeVisible();
  } finally {
    if (sidebarPreference === null)
      window.localStorage.removeItem("deckpress.sidebar");
    else window.localStorage.setItem("deckpress.sidebar", sidebarPreference);
    vi.useRealTimers();
  }
});

it.each([22, 43, 250])(
  "keeps one Discover loading announcement across a sidebar toggle during a %i ms search",
  async (duration) => {
    const sidebarPreference = window.localStorage.getItem("deckpress.sidebar");
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/#/discover");
      const search =
        Promise.withResolvers<Awaited<ReturnType<typeof api.searchDecks>>>();
      vi.spyOn(api, "searchDecks").mockReturnValue(search.promise);
      const advance = (ms: number) =>
        act(() => vi.advanceTimersByTimeAsync(ms));
      const getStatus = () =>
        screen.getByRole("status", { name: "Discover search loading" });
      renderWithClient(<App />);
      const status = getStatus();
      expect(status).toBeEmptyDOMElement();
      const input = screen.getByRole("searchbox", {
        name: "Search public decks by deck name",
      });
      fireEvent.change(input, { target: { value: "Burn" } });
      await advance(450);
      const message = "Searching Archidekt…";
      expect(
        screen.getAllByText(message).find((node) => node.closest(".loading")),
      ).toBeVisible();
      expect(getStatus()).toBe(status);
      const announcement = within(status).getByRole("group");
      expect(announcement).toHaveTextContent(message);
      const app = status.closest(".app-shell");
      const sidebar = app?.getAttribute("data-sidebar");
      await advance(Math.floor(duration / 2));
      fireEvent.keyDown(input, { key: "b", ctrlKey: true });
      expect(app?.getAttribute("data-sidebar")).not.toBe(sidebar);
      await advance(Math.ceil(duration / 2));
      expect(getStatus()).toBe(status);
      expect(within(status).getByRole("group")).toBe(announcement);
      await act(async () => {
        search.resolve({
          items: [],
          page: 1,
          hasMore: false,
          total: 0,
          matchedCard: null,
          cardMatches: [],
        });
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(
        screen.getByRole("heading", { name: "No decks found" }),
      ).toBeVisible();
      expect(getStatus()).toBe(status);
      expect(status).toBeEmptyDOMElement();
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      if (sidebarPreference === null)
        window.localStorage.removeItem("deckpress.sidebar");
      else window.localStorage.setItem("deckpress.sidebar", sidebarPreference);
    }
  },
);

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(
    function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
      this.querySelector<HTMLElement>("[autofocus]")?.focus();
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

it("shows the calibration ruler hint only on jobs that included it", async () => {
  const job = {
    id,
    deckId: id,
    status: "completed",
    completed: 60,
    total: 60,
    message: "PDF ready",
    createdAt: deck.createdAt,
    fileName: "Burn.pdf",
    bytes: 1000,
    pages: 7,
  };
  mockIPC((cmd) => {
    if (cmd === "health")
      return { status: "ok", service: "@deckpress/desktop" };
    if (cmd === "list_jobs")
      return [
        { ...job, deckName: "Without calibration", calibrationPage: false },
        {
          ...job,
          id: "85ec616b-91ec-4da4-be64-be378806c981",
          deckName: "With calibration",
          pages: 8,
          calibrationPage: true,
        },
        {
          ...job,
          id: "bfdd21b1-4be2-4bbc-a6ac-30c07b752520",
          deckName: "Older export",
        },
      ];
    return [];
  });
  window.history.replaceState(null, "", "#/jobs");
  renderWithClient(<App />);
  await screen.findByRole("heading", { name: "Without calibration" });
  expect(screen.getByText("3 exports")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Older export" })).toBeVisible();
  const hint = screen.getByText(
    /measure the ruler on the print-size calibration page/i,
  );
  expect(hint.closest("article")).toHaveTextContent("With calibration");
});

it.each([
  [0, 0, 0, "0 PDF pages", "0 / 0 faces"],
  [1, 0, 1, "1 PDF page", "0 / 1 face"],
  [1, 1, 1, "1 PDF page", "1 / 1 face"],
  [2, 1, 2, "2 PDF pages", "1 / 2 faces"],
])(
  "shows %i PDF pages and %i of %i faces with the right forms",
  async (pages, completed, total, pageLabel, faceLabel) => {
    const job: PrintJob = {
      id,
      deckId: id,
      deckName: "Burn",
      status: "failed",
      completed,
      total,
      message: "Export failed",
      createdAt: deck.createdAt,
      fileName: "Burn.pdf",
      bytes: 0,
      pages,
      calibrationPage: false,
      format: "pdf",
    };
    mockIPC((cmd) => (cmd === "list_jobs" ? [job] : []));
    window.history.replaceState(null, "", "#/jobs");
    renderWithClient(<App />);
    const card = await screen.findByRole("article");
    expect(within(card).getByText(pageLabel)).toBeVisible();
    expect(within(card).getByText(faceLabel)).toBeVisible();
    expect(screen.getByText("1 export")).toBeVisible();
  },
);

it("shows a singular card count in the deck workspace", async () => {
  const user = userEvent.setup();
  const singleCardDeck = { ...deck, entries: [{ ...entry, quantity: 1 }] };
  mockIPC((cmd) => {
    if (cmd === "list_decks") return [singleCardDeck];
    if (cmd === "get_deck") return singleCardDeck;
    return [];
  });
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  expect(await screen.findByText("1 card", { exact: true })).toBeVisible();
});

it("suggests related tokens and saves them in the tokens zone only when added", async () => {
  const tokenId = "138aacf8-01a2-4e63-a43a-e42eb1abc32c";
  const token: DeckEntry = {
    ...entry,
    id: tokenId,
    card: { ...entry.card, id: tokenId, oracleId: tokenId, name: "Treasure" },
    quantity: 1,
    zone: "tokens",
  };
  const lookup = Promise.withResolvers<DeckEntry[]>();
  const suggest = vi.fn().mockReturnValue(lookup.promise);
  const saveDeck = vi.fn((next: Deck) => next);
  mockIPC((cmd, args) => {
    if (cmd === "list_decks") return [deck];
    if (cmd === "get_deck") return deck;
    if (cmd === "related_tokens") return suggest(args);
    if (cmd === "save_deck") return saveDeck((args as { deck: Deck }).deck);
    return [];
  });
  const user = userEvent.setup();
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  const tokenStatus = screen.getByRole("status", {
    name: "Token lookup status",
  });
  expect(tokenStatus).toBeEmptyDOMElement();
  expect(suggest).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: "Find tokens" }));
  await waitFor(() => expect(tokenStatus).toHaveTextContent("Finding tokens…"));
  lookup.resolve([token]);
  const add = await screen.findByRole("button", { name: "Add Treasure" });
  await waitFor(() =>
    expect(tokenStatus).toHaveTextContent(
      "Found 1 additional token or emblem.",
    ),
  );
  expect(suggest).toHaveBeenCalledWith({ cardIds: [id] });
  expect(saveDeck).not.toHaveBeenCalled();
  await user.click(add);
  await waitFor(() =>
    expect(tokenStatus).toHaveTextContent(
      "No additional tokens or emblems found.",
    ),
  );
  expect(screen.queryByRole("button", { name: "Add Treasure" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Choose art for Treasure" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(saveDeck).toHaveBeenCalledWith(
    expect.objectContaining({ entries: [entry, token] }),
  );
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Burn", level: 1 }),
  );
});

it.each(["Save changes", "body"])(
  "focuses the deck heading when Ctrl+S saves from %s",
  async (start) => {
    const user = userEvent.setup();
    vi.spyOn(api, "decks").mockResolvedValue([deck]);
    vi.spyOn(api, "deck").mockResolvedValue(deck);
    const save = vi
      .spyOn(api, "saveDeck")
      .mockImplementation(async (next) => next);
    renderWithClient(<App />);
    await user.click(await screen.findByRole("button", { name: "Open Burn" }));
    await user.click(
      await screen.findByRole("button", { name: "Edit card quantities" }),
    );
    const print = screen.getByRole("checkbox", {
      name: "Print Lightning Bolt",
    });
    await user.click(print);
    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toBeEnabled();
    if (start === "body") print.blur();
    else button.focus();
    expect(document.activeElement).toBe(
      start === "body" ? document.body : button,
    );

    await user.keyboard("{Control>}s{/Control}");

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [{ ...entry, excluded: true }] }),
    );
    expect(button).toBeDisabled();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Burn", level: 1 }),
    );
  },
);

it("keeps focus in the editor when saving with Ctrl+S", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "decks").mockResolvedValue([deck]);
  vi.spyOn(api, "deck").mockResolvedValue(deck);
  const save = vi
    .spyOn(api, "saveDeck")
    .mockImplementation(async (next) => next);
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  await user.click(
    await screen.findByRole("button", { name: "Edit card quantities" }),
  );
  await user.click(
    screen.getByRole("checkbox", { name: "Print Lightning Bolt" }),
  );
  const search = screen.getByRole("searchbox", { name: "Find a card" });
  await user.type(search, "Bolt");
  await user.keyboard("{Control>}s{/Control}");
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ entries: [{ ...entry, excluded: true }] }),
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(document.activeElement).toBe(search);
});

it.each(["search", "Save changes"] as const)(
  "keeps or safely restores focus throughout a pending save from %s",
  async (start) => {
    const pending = Promise.withResolvers<Deck>();
    const user = userEvent.setup();
    vi.spyOn(api, "decks").mockResolvedValue([deck]);
    vi.spyOn(api, "deck").mockResolvedValue(deck);
    const save = vi.spyOn(api, "saveDeck").mockReturnValue(pending.promise);
    renderWithClient(<App />);
    await user.click(await screen.findByRole("button", { name: "Open Burn" }));
    await user.click(
      await screen.findByRole("button", { name: "Edit card quantities" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Print Lightning Bolt" }),
    );
    const search = screen.getByRole("searchbox", { name: "Find a card" });
    const button = screen.getByRole("button", { name: "Save changes" });
    if (start === "search") {
      await user.type(search, "Bolt");
      await user.keyboard("{Control>}s{/Control}");
    } else {
      await user.click(button);
    }
    expect(screen.getByRole("status", { name: "Saving…" })).toBeVisible();
    expect(button).toBeDisabled();
    expect(search).toBeEnabled();
    if (start === "search") expect(search).toHaveFocus();

    const snapshot = save.mock.calls[0]?.[0];
    if (!snapshot) throw new Error("Save did not start");
    pending.resolve(snapshot);
    expect(await screen.findByRole("status", { name: "Saved" })).toBeVisible();
    expect(
      start === "search"
        ? search
        : screen.getByRole("heading", { name: "Burn", level: 1 }),
    ).toHaveFocus();
  },
);

it("names the save status and exposes its tooltip when switching to Print setup with unsaved changes", async () => {
  mockIPC((cmd) => {
    if (cmd === "list_decks") return [deck];
    if (cmd === "get_deck") return deck;
    return [];
  });
  const user = userEvent.setup();
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  expect(await screen.findByRole("status", { name: "Saved" })).toHaveAttribute(
    "title",
    "Saved",
  );
  await user.click(
    screen.getByRole("button", { name: "Edit card quantities" }),
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Copies of Lightning Bolt" }),
    {
      target: { value: "5" },
    },
  );
  await user.click(screen.getByRole("button", { name: "Print setup" }));
  expect(
    screen.getByRole("status", { name: "Unsaved changes" }),
  ).toHaveAttribute("title", "Unsaved changes");
});

it("shows the pending save status until the save fails or succeeds", async () => {
  const failedSave = Promise.withResolvers<Deck>();
  const successfulSave = Promise.withResolvers<Deck>();
  vi.spyOn(api, "saveDeck")
    .mockReturnValueOnce(failedSave.promise)
    .mockReturnValueOnce(successfulSave.promise);
  mockIPC((cmd) => {
    if (cmd === "list_decks") return [deck];
    if (cmd === "get_deck") return deck;
    return [];
  });
  const user = userEvent.setup();
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  await user.click(
    await screen.findByRole("button", { name: "Edit card quantities" }),
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Copies of Lightning Bolt" }),
    { target: { value: "5" } },
  );
  const expectStatus = async (name: string) => {
    expect(await screen.findByRole("status", { name })).toHaveAttribute(
      "title",
      name,
    );
  };
  const save = screen.getByRole("button", { name: "Save changes" });
  await user.click(save);
  await expectStatus("Saving…");
  failedSave.reject(new Error("Save failed"));
  await expectStatus("Unsaved changes");
  await user.click(save);
  await expectStatus("Saving…");
  successfulSave.resolve({ ...deck, entries: [{ ...entry, quantity: 5 }] });
  await expectStatus("Saved");
});

it.each([false, true])(
  "restores a deck JSON backup (named boards: %s)",
  async (named) => {
    const user = userEvent.setup();
    const restoredId = "221c934a-dc11-4c97-88ff-ff467375a521";
    const original = deckSchema.parse(legacyBackup);
    if (named) {
      original.entries.push({
        ...entry,
        zone: "maybe",
        board: "Considering",
      });
      original.entries.push({
        ...entry,
        id: "6f1e2c55-3d7a-4c9e-9a51-2b8f0d4e7c13",
        quantity: 1,
        zone: "companion",
      });
    }
    let restored: Deck | undefined;
    const saveText = vi.fn();
    mockIPC((cmd, args) => {
      if (cmd === "list_decks")
        return restored ? [original, restored] : [original];
      if (cmd === "get_deck")
        return (args as { id: string }).id === restoredId ? restored : original;
      if (cmd === "export_file_name") return exportFileName(args);
      if (cmd === "plugin:dialog|save") return "/chosen/deck.deckpress.json";
      if (cmd === "save_text") return saveText(args);
      if (cmd === "restore_deck") {
        restored = deckSchema.parse({
          ...JSON.parse((args as { contents: string }).contents),
          id: restoredId,
        });
        return { deck: restored, updatedUploads: 0 };
      }
      return [];
    });
    renderWithClient(<App />);
    let contents = JSON.stringify(legacyBackup);
    if (named) {
      await user.click(
        await screen.findByRole("button", { name: "Open Legacy backup" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Back up deck as JSON" }),
      );
      await waitFor(() => expect(saveText).toHaveBeenCalledOnce());
      [{ contents }] = saveText.mock.calls[0] as [{ contents: string }];
      expect(JSON.parse(contents).entries).toEqual(original.entries);
      await user.click(screen.getByRole("button", { name: "Decks" }));
    }
    const file = new File([contents], "deck.deckpress.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", { value: async () => contents });
    await user.upload(
      await screen.findByLabelText("Restore a deck from a JSON backup"),
      file,
    );
    await waitFor(() =>
      expect(window.location.hash).toBe(`#/decks/${restoredId}`),
    );
    expect(restored?.entries).toEqual(original.entries);
    await user.click(
      await screen.findByRole("button", { name: "Edit card quantities" }),
    );
    await user.click(screen.getByRole("button", { name: /Maybeboard\s*2/ }));
    expect(screen.getByRole("button", { name: /^Opt/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Lightning Bolt/ }),
    ).not.toBeInTheDocument();
    if (named) {
      await user.click(screen.getByRole("button", { name: /Considering\s*4/ }));
      expect(
        screen.getByRole("button", { name: /^Lightning Bolt/ }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /^Opt/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Board for Lightning Bolt" }),
      ).toHaveDisplayValue("Considering");
      expect(
        screen.getByRole("button", { name: /^Companion\s*1$/ }),
      ).toBeVisible();
    }
  },
);

it("imports an MPC Autofill order without changing image IDs and exports it through the save dialog", async () => {
  const art = { ...community, id: "mpc:front_id" };
  const back = { ...community, id: "mpc:back_id" };
  const order =
    "<order><details><quantity>2</quantity></details><fronts><card><id>front_id</id><slots>1,0</slots></card></fronts><cardback>back_id</cardback></order>";
  let stored = { ...deck, entries: [] as DeckEntry[] };
  const saveMpcXml = vi.fn();
  const mpcArtwork = vi.fn(() => [
    { art, filename: "Front.png", query: "lightning bolt" },
    { art: back, filename: "Back.png", query: "b:custom" },
  ]);
  mockIPC((cmd, args) => {
    if (cmd === "list_decks") return [stored];
    if (cmd === "get_deck") return stored;
    if (cmd === "mpc_artwork") return mpcArtwork();
    if (cmd === "save_deck") {
      stored = deckSchema.parse((args as { deck: Deck }).deck);
      return stored;
    }
    if (cmd === "export_file_name") return exportFileName(args);
    if (cmd === "plugin:dialog|save") return "/chosen/burn.xml";
    if (cmd === "save_mpc_xml") return saveMpcXml(args);
    if (cmd === "resolve_cards")
      throw new Error("MPC must not resolve on Scryfall");
    return [];
  });
  const user = userEvent.setup();
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  await user.click(await screen.findByLabelText("Decklist"));
  await user.paste(order);
  await user.click(
    screen.getByRole("button", { name: "Read MPC Autofill order" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Add 2 cards to deck" }),
  );
  expect(stored.entries).toEqual([
    expect.objectContaining({
      quantity: 2,
      card: expect.objectContaining({ faces: [art, back] }),
    }),
  ]);
  await user.click(
    screen.getByRole("button", { name: "Export MPC Autofill XML" }),
  );
  await waitFor(() =>
    expect(saveMpcXml).toHaveBeenCalledWith({
      destination: "/chosen/burn.xml",
      contents: expect.stringContaining("<cardback>back_id</cardback>"),
    }),
  );
  const mpcStatus = screen.getByRole("status", {
    name: "MPC Autofill XML export status",
  });
  expect(mpcStatus).toHaveTextContent("MPC Autofill XML saved.");
  expect(mpcArtwork).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Print setup" }));
  await user.click(
    await screen.findByRole("button", { name: "Other exports" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "MPC Autofill XML" }));
  await waitFor(() => expect(saveMpcXml).toHaveBeenCalledTimes(2));
  expect(saveMpcXml).toHaveBeenLastCalledWith({
    destination: "/chosen/burn.xml",
    contents: expect.stringContaining("<cardback>back_id</cardback>"),
  });
  expect(mpcStatus).toHaveTextContent("MPC Autofill XML saved.");
});

it("asks for an MPC back instead of opening the save dialog for a front-only deck", async () => {
  const frontOnly = {
    ...deck,
    entries: [{ ...entry, selectedArt: community }],
  };
  const saveDialog = vi.fn();
  const saveMpcXml = vi.fn();
  mockIPC((cmd, args) => {
    if (cmd === "list_decks") return [frontOnly];
    if (cmd === "get_deck") return frontOnly;
    if (cmd === "plugin:dialog|save") return saveDialog(args);
    if (cmd === "save_mpc_xml") return saveMpcXml(args);
    return [];
  });
  const user = userEvent.setup();
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  await user.click(
    screen.getByRole("button", { name: "Export MPC Autofill XML" }),
  );
  expect(
    await within(screen.getByRole("main")).findByRole("alert"),
  ).toHaveTextContent("Choose an MPC Autofill back");
  expect(saveDialog).not.toHaveBeenCalled();
  expect(saveMpcXml).not.toHaveBeenCalled();
});

it("passes the resolved canvas color to the native reveal command", async () => {
  const invoke = vi.fn();
  mockIPC(invoke);
  document.documentElement.style.setProperty("--canvas", "#111317");
  try {
    await showThemedWindow();
  } finally {
    document.documentElement.style.removeProperty("--canvas");
  }
  expect(invoke).toHaveBeenCalledExactlyOnceWith("show_themed_window", {
    canvas: "#111317",
  });
});

it("restores a saved appearance before settings loads and clears it on System", async () => {
  const user = userEvent.setup();
  const root = document.documentElement;
  const storage = window.localStorage;
  const bootScript = readFileSync(
    resolve(import.meta.dirname, "../public/appearance.js"),
    "utf8",
  );
  let dark = false;
  let system = new EventTarget();
  const restart = () => {
    delete root.dataset.theme;
    system = new EventTarget();
    runInNewContext(bootScript, {
      document,
      localStorage: storage,
      matchMedia: () =>
        Object.defineProperty(system, "matches", { get: () => dark }),
      window,
    });
  };
  const themeKey = "deckpress.theme";
  window.history.replaceState(null, "", "#/settings");
  mockIPC(() => []);

  try {
    storage.setItem(themeKey, "invalid");
    restart();
    const { unmount } = renderWithClient(<App />);
    const theme = screen.getByRole("combobox", { name: "Theme" });
    expect(theme).toHaveValue("system");
    expect(root).toHaveAttribute("data-theme", "light");
    dark = true;
    system.dispatchEvent(new Event("change"));
    expect(root).toHaveAttribute("data-theme", "dark");

    await user.selectOptions(theme, "dark");
    expect(root).toHaveAttribute("data-theme", "dark");
    expect(storage.getItem(themeKey)).toBe("dark");

    await user.selectOptions(theme, "light");
    unmount();
    restart();
    expect(root).toHaveAttribute("data-theme", "light");

    renderWithClient(<App />);
    const restoredTheme = screen.getByRole("combobox", { name: "Theme" });
    expect(restoredTheme).toHaveValue("light");
    dark = false;
    system.dispatchEvent(new Event("change"));
    dark = true;
    system.dispatchEvent(new Event("change"));
    expect(root).toHaveAttribute("data-theme", "light");
    await user.selectOptions(restoredTheme, "system");
    expect(root).toHaveAttribute("data-theme", "dark");
    expect(storage.getItem(themeKey)).toBeNull();

    dark = false;
    storage.setItem(themeKey, "light");
    window.deckpressInitialAppearance = "dark";
    restart();
    expect(root).toHaveAttribute("data-theme", "dark");
    window.deckpressInitialAppearance = "system";
    dark = true;
    restart();
    expect(root).toHaveAttribute("data-theme", "dark");
  } finally {
    delete root.dataset.theme;
    delete window.deckpressAppearance;
    delete window.deckpressInitialAppearance;
    storage.removeItem(themeKey);
  }
});

it("shows the model download error and retries the same model", async () => {
  const user = userEvent.setup();
  const qualityModel = {
    ...compactModel,
    id: "realesrgan-x4plus",
    name: "RealESRGAN x4plus (quality)",
    tier: "quality" as const,
    url: "https://example.com/quality.onnx",
    bundled: false,
    installed: false,
  };
  const settings = {
    models: [compactModel, qualityModel],
    defaultModel: compactModel.id,
    loaded: null,
    storage: "Local SQLite",
    localOnly: true,
    dataDir: "/tmp/deckpress",
    styleModel: null,
  };
  const installedModels = [compactModel, { ...qualityModel, installed: true }];
  const message = `${qualityModel.name} download failed (HTTP 404): ${qualityModel.url}`;
  const firstAttempt = Promise.withResolvers<typeof installedModels>();
  const download = vi.fn().mockReturnValueOnce(firstAttempt.promise);
  download.mockImplementationOnce(() => {
    vi.mocked(api.settings).mockResolvedValue({
      ...settings,
      models: installedModels,
    });
    return installedModels;
  });
  vi.mocked(api.settings).mockResolvedValue(settings);
  mockIPC((cmd, args) => {
    if (cmd === "download_model") return download(args);
    if (cmd === "health") {
      return { status: "ok", service: "@deckpress/desktop" };
    }
    return [];
  });
  window.history.replaceState(null, "", "#/settings");
  renderWithClient(<App />);

  await user.click(await screen.findByRole("button", { name: "Download" }));
  const status = screen.getByRole("status", { name: "Model download status" });
  expect(status).toHaveTextContent(`Downloading ${qualityModel.name}…`);
  firstAttempt.reject(message);
  const error = await screen.findByText(message);
  expect(status).toBeEmptyDOMElement();
  const notice = error.closest("[role=alert]") as HTMLElement;
  await user.click(within(notice).getByRole("button", { name: "Retry" }));

  expect(
    await screen.findAllByRole("button", { name: "Load now" }),
  ).toHaveLength(2);
  expect(screen.queryByText(message)).toBeNull();
  await waitFor(() =>
    expect(status).toHaveTextContent(`${qualityModel.name} downloaded.`),
  );
  expect(download.mock.calls).toEqual([
    [{ id: qualityModel.id }],
    [{ id: qualityModel.id }],
  ]);
});

it.each([
  [0, "0 PNG files"],
  [1, "1 PNG file"],
  [2, "2 PNG files"],
])("counts %i PNG files on the job card", async (pages, label) => {
  const job: PrintJob = {
    id,
    deckId: id,
    deckName: "Burn",
    status: "completed",
    completed: pages,
    total: pages,
    message: "Ready",
    createdAt: deck.createdAt,
    fileName: "Burn-800dpi-png.zip",
    bytes: 0,
    pages,
    calibrationPage: false,
    format: "png",
  };
  mockIPC((cmd) => (cmd === "list_jobs" ? [job] : []));
  window.history.replaceState(null, "", "#/jobs");
  renderWithClient(<App />);
  expect(await screen.findByText(label, { exact: true })).toBeVisible();
});

it("announces PNG export phases once, naming skipped faces on completion", async () => {
  const user = userEvent.setup();
  const queued: PrintJob = {
    id,
    deckId: id,
    deckName: "Burn",
    status: "queued",
    completed: 0,
    total: 3,
    message: "Queued · PNG files",
    createdAt: deck.createdAt,
    fileName: "Burn-800dpi-png.zip",
    bytes: 0,
    pages: 0,
    calibrationPage: false,
    format: "png",
  };
  let jobs = [queued];
  mockIPC((cmd) => (cmd === "list_jobs" ? jobs : []));
  window.history.replaceState(null, "", "#/jobs");
  renderWithClient(<App />);
  const status = screen.getByRole("status", {
    name: "Print job announcements",
  });
  const alert = screen.getByRole("alert", { name: "Print job failures" });
  await waitFor(() =>
    expect(status).toHaveTextContent(/^PNG export for Burn queued\.$/),
  );
  const refresh = screen.getByRole("button", { name: "Refresh print jobs" });

  const message =
    "2 PNG files ready · 1 face without art skipped: Bolt back (sheet 1, slot 1)";
  const completed: PrintJob = {
    ...queued,
    status: "completed",
    completed: 3,
    pages: 2,
    message,
  };
  jobs = [completed];
  await user.click(refresh);
  expect(await screen.findByText(message)).toBeVisible();
  await waitFor(() =>
    expect(status).toHaveTextContent(
      `PNG export for Burn started and completed: ${message}`,
    ),
  );
  const announcement = status.firstChild;
  await user.click(refresh);
  expect(status.firstChild).toBe(announcement);
  expect(alert).toBeEmptyDOMElement();

  jobs = [
    completed,
    {
      ...queued,
      id: "338aacf8-01a2-4e63-a43a-e42eb1abc32c",
      status: "failed",
      message: "None of the selected faces have art to export",
    },
  ];
  await user.click(refresh);
  await waitFor(() =>
    expect(alert).toHaveTextContent(
      "PNG export for Burn started and failed: None of the selected faces have art to export",
    ),
  );
  expect(status.firstChild).toBe(announcement);
});

it("keeps fast print-job finals and discards only superseded phases for the same job", async () => {
  const queued: PrintJob = {
    id,
    deckId: id,
    deckName: "First deck",
    status: "queued",
    completed: 0,
    total: 4,
    message: "Queued",
    createdAt: deck.createdAt,
    fileName: "burn.pdf",
    bytes: 0,
    pages: 1,
    calibrationPage: false,
    format: "pdf",
  };
  const second: PrintJob = {
    ...queued,
    id: "238aacf8-01a2-4e63-a43a-e42eb1abc32c",
    deckName: "Second deck",
  };
  const failed: PrintJob = {
    ...queued,
    id: "338aacf8-01a2-4e63-a43a-e42eb1abc32c",
    deckName: "Failed deck",
  };
  const cancelled: PrintJob = {
    ...queued,
    id: "438aacf8-01a2-4e63-a43a-e42eb1abc32c",
    deckName: "Cancelled deck",
  };
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  mockIPC(() => []);
  window.history.replaceState(null, "", "#/jobs");
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "No print jobs yet" });
  const status = screen.getByRole("status", {
    name: "Print job announcements",
  });
  const alert = screen.getByRole("alert", { name: "Print job failures" });
  const update = async (...jobs: PrintJob[]) => {
    client.setQueryData(["jobs"], jobs);
    await advance(0);
  };
  const emitted: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node.textContent) emitted.push(node.textContent.trim());
  });
  observer.observe(status, { childList: true });
  observer.observe(alert, { childList: true });
  vi.useFakeTimers();
  try {
    await update(queued, second, failed);
    await advance(25);
    await update(
      { ...queued, status: "completed" },
      { ...failed, status: "failed", message: "Disk full" },
    );
    expect(status).toHaveTextContent("First deck started and completed.");
    expect(alert).toHaveTextContent(
      "Failed deck started and failed: Disk full",
    );
    await advance(25);
    await update({ ...second, status: "completed" });
    await advance(75);
    expect(status).toHaveTextContent("Second deck started and completed.");
    await update({ ...cancelled, status: "running" });
    await advance(100);
    expect(status).toHaveTextContent("Cancelled deck running.");
    await update({ ...cancelled, status: "cancelled" });
    await advance(100);
    expect(status).toHaveTextContent(/^Cancelled$/);
    await update({ ...cancelled, status: "cancelled", message: "Cancelled" });
    await update({ ...cancelled, status: "running" });
    await advance(50);
    expect(emitted).toEqual([
      "Print job for First deck started and completed.",
      "Print job for Failed deck started and failed: Disk full",
      "Print job for Second deck started and completed.",
      "Print job for Cancelled deck running.",
      "Cancelled",
    ]);
  } finally {
    observer.disconnect();
    vi.useRealTimers();
  }
});

const failedExport: PrintJob = {
  id: "138aacf8-01a2-4e63-a43a-e42eb1abc32c",
  deckId: id,
  deckName: deck.name,
  status: "failed",
  completed: 0,
  total: 1,
  message: "Uploaded image not found",
  createdAt: deck.createdAt,
  fileName: "burn-150dpi.pdf",
  bytes: 0,
  pages: 0,
  calibrationPage: false,
  format: "pdf",
  settings: printSettingsSchema.parse({ dpi: 150, calibrationPage: false }),
  failureTarget: { kind: "card", entryId: entry.id, back: false },
};

it.each([
  failedExport,
  {
    ...failedExport,
    message: "Cancelled",
    status: "cancelled",
    failureTarget: undefined,
  },
  {
    ...failedExport,
    message: "Could not load model",
    failureTarget: { kind: "upscaleModel" },
  },
] satisfies PrintJob[])(
  "opens Print setup for a job with message $message without queuing",
  async (job) => {
    const user = userEvent.setup();
    const create = vi.fn();
    const recoveryDeck = {
      ...deck,
      entries: [
        {
          ...entry,
          id: "238aacf8-01a2-4e63-a43a-e42eb1abc32c",
          quantity: 1,
          card: { ...entry.card, name: "Forest" },
        },
        { ...entry, quantity: 1 },
      ],
      printSettings: printSettingsSchema.parse({
        columns: 1,
        rows: 1,
        calibrationPage: false,
      }),
    };
    mockIPC((cmd) => {
      if (cmd === "list_jobs") return [job];
      if (cmd === "list_decks") return [deck];
      if (cmd === "get_deck")
        return job.failureTarget?.kind === "card"
          ? recoveryDeck
          : job.failureTarget?.kind === "upscaleModel"
            ? {
                ...deck,
                printSettings: { ...deck.printSettings, upscale: true },
              }
            : deck;
      if (cmd === "create_job") return create();
      return [];
    });
    window.history.replaceState(null, "", "#/jobs");
    renderWithClient(<App />);
    const back = await screen.findByRole("button", {
      name: "Back to print setup",
    });
    expect(screen.getByRole("heading", { name: deck.name })).toBeVisible();
    expect(screen.getByText(job.message)).toBeVisible();
    back.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("heading", { name: "Print setup" }),
    ).toBeVisible();
    const status = screen.getByRole("status", {
      name: "Print job announcements",
    });
    await waitFor(() =>
      expect(status).toHaveTextContent(`Opening Print setup for ${deck.name}.`),
    );
    const announcement = status.firstElementChild;
    expect(announcement).toHaveTextContent(
      `Opening Print setup for ${deck.name}.`,
    );
    if (job.failureTarget?.kind === "card") {
      expect(screen.getByText("Page 2 of 2 · Sheet 2 · front")).toBeVisible();
      const preview = screen.getByRole("img", { name: /^Print preview,/ });
      expect(screen.getByText("Lightning Bolt:")).toBeVisible();
      const highlightedCard = preview.querySelector(".print-failed-card");
      expect(highlightedCard).toBeInTheDocument();
      const print = screen.getByRole("checkbox", {
        name: "Print Lightning Bolt",
      });
      expect(print).toHaveFocus();
      expect(print).toHaveClass("blocker-focus");
      expect(print).toBeChecked();
      expect(print).toHaveAccessibleDescription(
        "Lightning Bolt: Uploaded image not found",
      );
    } else if (job.failureTarget?.kind === "upscaleModel") {
      expect(
        screen.getByRole("combobox", { name: "Model" }),
      ).toHaveAccessibleDescription("AI upscaling model: Could not load model");
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Model" })).toHaveFocus(),
      );
    } else {
      expect(document.getElementById("print-failure")).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "Print jobs" }));
    await user.click(
      await screen.findByRole("button", { name: "Back to print setup" }),
    );
    await waitFor(() =>
      expect(status.firstElementChild).not.toBe(announcement),
    );
    expect(status.firstElementChild).toHaveTextContent(
      `Opening Print setup for ${deck.name}.`,
    );
    expect(create).not.toHaveBeenCalled();
  },
);

it("does not offer setup or Retry when the original deck has been deleted", async () => {
  mockIPC((cmd) => (cmd === "list_jobs" ? [failedExport] : []));
  window.history.replaceState(null, "", "#/jobs");
  renderWithClient(<App />);
  expect(await screen.findByText("This deck no longer exists.")).toBeVisible();
  expect(screen.getByRole("heading", { name: deck.name })).toBeVisible();
  expect(screen.getByText(failedExport.message)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Back to print setup" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
});

it.each(["pdf", "png"] as const)(
  "retries a %s export with the same deck and original settings and announces the new job",
  async (format) => {
    const failed = { ...failedExport, format };
    const queued: PrintJob = {
      ...failed,
      id,
      status: "queued",
      message: "Queued",
      failureTarget: undefined,
    };
    let jobs = [failed];
    const create = vi.fn(() => {
      jobs = [queued, failed];
      return queued;
    });
    mockIPC((cmd, args) => {
      if (cmd === "list_jobs") return jobs;
      if (cmd === "list_decks") return [deck];
      if (cmd === "create_job") {
        expect(args).toEqual({
          deckId: deck.id,
          settings: failedExport.settings,
          format,
        });
        return create();
      }
      return [];
    });
    window.history.replaceState(null, "", "#/jobs");
    renderWithClient(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("progressbar")).toBeVisible();
    expect(create).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Print job announcements" }),
      ).toHaveTextContent(
        `${format === "png" ? "PNG export" : "Print job"} for ${deck.name} queued.`,
      ),
    );
  },
);

it("offers setup but not Retry when a legacy job has no original settings", async () => {
  const legacy = { ...failedExport, settings: undefined, format: undefined };
  mockIPC((cmd) => {
    if (cmd === "list_jobs") return [legacy];
    if (cmd === "list_decks") return [deck];
    return [];
  });
  window.history.replaceState(null, "", "#/jobs");
  renderWithClient(<App />);
  expect(
    await screen.findByRole("button", { name: "Back to print setup" }),
  ).toBeVisible();
  expect(
    screen.getByText("Original print settings unavailable for Retry."),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
});
it("announces print job phases once, leaving polling ticks in the progress control", async () => {
  const user = userEvent.setup();
  const queued: PrintJob = {
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
    calibrationPage: false,
    format: "pdf",
  };
  const oldJob: PrintJob = {
    ...queued,
    id: "138aacf8-01a2-4e63-a43a-e42eb1abc32c",
    deckName: "Older deck",
    status: "failed",
    message: "Old error",
  };
  let jobs = [queued, oldJob];
  const save = Promise.withResolvers<number>();
  mockIPC((cmd) => {
    if (cmd === "list_jobs") return jobs;
    if (cmd === "plugin:dialog|save") return "/chosen/burn.pdf";
    if (cmd === "save_pdf") return save.promise;
    return [];
  });
  window.history.replaceState(null, "", "#/jobs");
  renderWithClient(<App />);
  const status = screen.getByRole("status", {
    name: "Print job announcements",
  });
  const alert = screen.getByRole("alert", { name: "Print job failures" });
  const progress = await screen.findByRole("progressbar", {
    name: "Export progress for Burn",
  });
  await waitFor(() =>
    expect(status).toHaveTextContent(/^Print job for Burn queued\.$/),
  );
  expect(alert).toBeEmptyDOMElement();
  expect(screen.getByText("Old error")).toBeVisible();
  const refresh = screen.getByRole("button", { name: "Refresh print jobs" });

  const running = {
    ...queued,
    status: "running" as const,
    completed: 1,
    message: "Rendering face 1 of 4",
  };
  jobs = [running, oldJob];
  await user.click(refresh);
  expect(await screen.findByText(running.message)).toBeVisible();
  await waitFor(() =>
    expect(status).toHaveTextContent("Print job for Burn running."),
  );
  const runningAnnouncement = status.firstChild;
  expect(progress).toHaveValue(1);

  const tick = "Rendering face 2 of 4";
  jobs = [{ ...running, completed: 2, message: tick }, oldJob];
  await user.click(refresh);
  expect(await screen.findByText(tick)).toBeVisible();
  expect(screen.getByText(tick).closest("[role=status]")).toBeNull();
  expect(status.firstChild).toBe(runningAnnouncement);
  expect(status).toHaveTextContent("Print job for Burn running.");
  expect(progress).toHaveValue(2);

  const secondJob: PrintJob = {
    ...queued,
    id: "338aacf8-01a2-4e63-a43a-e42eb1abc32c",
    deckName: "Second deck",
    status: "failed",
    message: "Disk full",
  };
  const completed: PrintJob = {
    ...running,
    status: "completed",
    completed: 4,
    message: "1 page ready",
  };
  jobs = [completed, secondJob, oldJob];
  await user.click(refresh);
  expect(await screen.findByText("1 page ready")).toBeVisible();
  await waitFor(() =>
    expect(status).toHaveTextContent(/^Print job for Burn completed\.$/),
  );
  expect(alert).toHaveTextContent(
    "Print job for Second deck started and failed: Disk full",
  );
  expect(progress).not.toBeInTheDocument();
  const completedAnnouncement = status.firstChild;
  jobs = [{ ...completed, message: "PDF ready" }, secondJob, oldJob];
  await user.click(refresh);
  expect(await screen.findByText("PDF ready")).toBeVisible();
  expect(status.firstChild).toBe(completedAnnouncement);

  const exportStatus = screen.getByRole("status", {
    name: "Export save status",
  });
  await user.click(screen.getByRole("button", { name: "Save a copy" }));
  expect(exportStatus).toHaveTextContent("Saving export for Burn…");
  save.resolve(20);
  await waitFor(() =>
    expect(exportStatus).toHaveTextContent("Export for Burn saved."),
  );
});

it.each([
  {
    terminal: "completed",
    role: "status",
    name: "Print job announcements",
    ending: "completed.",
  },
  {
    terminal: "failed",
    role: "alert",
    name: "Print job failures",
    ending: "failed: Disk full",
  },
] as const)(
  "announces start with $terminal when polling skips running",
  async ({ terminal, role, name, ending }) => {
    const user = userEvent.setup();
    const queued: PrintJob = {
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
      pages: 0,
      calibrationPage: false,
      format: "pdf",
    };
    let job = queued;
    mockIPC((cmd) => (cmd === "list_jobs" ? [job] : []));
    window.history.replaceState(null, "", "#/jobs");
    renderWithClient(<App />);
    const status = screen.getByRole("status", {
      name: "Print job announcements",
    });
    const target = screen.getByRole(role, { name });
    await waitFor(() =>
      expect(status).toHaveTextContent("Print job for Burn queued."),
    );

    const refresh = screen.getByRole("button", { name: "Refresh print jobs" });
    job = {
      ...queued,
      status: terminal,
      message: terminal === "failed" ? "Disk full" : "PDF ready",
    };
    await user.click(refresh);
    expect(await screen.findByText(job.message)).toBeVisible();
    const announcement = `Print job for Burn started and ${ending}`;
    await waitFor(() => expect(target.textContent?.trim()).toBe(announcement));
    if (role === "alert") expect(status).not.toHaveTextContent(announcement);

    const terminalMessage = target.firstChild;
    job = { ...job, bytes: 1024 ** 2 };
    await user.click(refresh);
    expect(await screen.findByText("1.0 MB")).toBeVisible();
    expect(target.firstChild).toBe(terminalMessage);
    expect(target.textContent?.trim()).toBe(announcement);
  },
);

it("focuses Deck name when New deck opens and returns to the opener on cancel", async () => {
  const user = userEvent.setup();
  mockIPC((cmd) => {
    if (cmd === "list_decks") return [];
    throw new Error(`Unexpected command: ${cmd}`);
  });
  renderWithClient(<App />);
  const opener = await screen.findByRole("button", {
    name: "Start an empty deck",
  });
  await user.click(opener);
  const dialog = screen.getByRole("dialog", { name: "New deck" });
  expect(document.activeElement).toBe(
    within(dialog).getByLabelText("Deck name"),
  );
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "New deck" })).toBeNull();
  expect(document.activeElement).toBe(opener);
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
    await screen.findByRole("button", { name: "Start an empty deck" }),
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
  ).toHaveAttribute("aria-disabled", "true");
  const heading = screen.getByRole("heading", { name: "Burn", level: 1 });
  expect(heading).toBeVisible();
  expect(heading).toHaveAttribute("tabindex", "-1");
  expect(document.activeElement).toBe(heading);
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

it("compares the selected scan and restores the chosen print model after saving", async () => {
  const user = userEvent.setup();
  const animeModel = {
    ...compactModel,
    id: "realesr-animevideov3",
    tier: "fast" as const,
  };
  const qualityModel = {
    ...compactModel,
    id: "realesrgan-x4plus",
    tier: "quality" as const,
    installed: false,
  };
  vi.mocked(api.settings).mockResolvedValue({
    ...(await api.settings()),
    models: [compactModel, animeModel, qualityModel],
  });
  const chosenEntry = {
    ...entry,
    id: "b4f5c8d1-0903-40be-8f8c-e9dcb5aa7240",
    card: { ...entry.card, name: "Second printing" },
    selectedArt: alternate,
  };
  let stored = { ...deck, entries: [entry, chosenEntry] };
  const calls: unknown[] = [];
  mockIPC((cmd, args) => {
    switch (cmd) {
      case "health":
        return { status: "ok", service: "@deckpress/desktop" };
      case "list_decks":
        return [stored];
      case "get_deck":
        return stored;
      case "save_deck":
        stored = deckSchema.parse((args as { deck: unknown }).deck);
        return stored;
      case "begin_upscale_comparison":
        return null;
      case "compare_upscalers":
        calls.push(args);
        return [null, compactModel.id, animeModel.id].map((modelId) => ({
          modelId,
          crop: {
            png: [137, 80, 78, 71],
            width: 224,
            height: 144,
            elapsedMs: 12.5,
          },
        }));
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  renderWithClient(<App />);
  const openPrint = async () => {
    await user.click(await screen.findByRole("button", { name: "Open Burn" }));
    await user.click(screen.getByRole("button", { name: "Print setup" }));
    await user.click(screen.getByText("Compare upscale models"));
  };
  await openPrint();
  await user.selectOptions(
    screen.getByLabelText("Comparison card"),
    chosenEntry.id,
  );
  await user.click(screen.getByRole("button", { name: "Render text crops" }));
  for (const label of ["Lanczos", "General x4v3", "Anime v3"]) {
    expect(
      await screen.findByRole("img", { name: `${label} text crop` }),
    ).toHaveAttribute("width", "224");
  }
  expect(screen.getAllByText("12.5 ms")).toHaveLength(3);
  expect(
    screen.getByRole("button", { name: "Use Quality x4plus" }),
  ).toBeDisabled();
  expect(calls).toEqual([expect.objectContaining({ art: alternate })]);
  await user.click(screen.getByRole("button", { name: "Use Anime v3" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(stored.printSettings.upscaleModel).toBe(animeModel.id),
  );
  await user.click(screen.getByRole("button", { name: "Back to decks" }));
  await openPrint();
  expect(
    screen.getByRole("button", { name: "Use Anime v3", pressed: true }),
  ).toBeVisible();
  expect(screen.getByLabelText("Use local AI upscaling")).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Use Lanczos" }));
  expect(screen.getByLabelText("Use local AI upscaling")).not.toBeChecked();
});

it("re-renders every installed crop after keyboard movement and a thumbnail drag", async () => {
  const user = userEvent.setup();
  const models = [
    compactModel,
    { ...compactModel, id: "anime", tier: "fast" as const },
    { ...compactModel, id: "quality", tier: "quality" as const },
  ];
  const calls: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "begin_upscale_comparison") return null;
    if (cmd !== "compare_upscalers")
      throw new Error(`Unexpected command: ${cmd}`);
    calls.push(args);
    return [null, ...models.map((model) => model.id)].map((modelId) => ({
      modelId,
      crop: {
        png: [137, 80, 78, 71],
        width: 224,
        height: 144,
        elapsedMs: calls.length * 12.5,
      },
    }));
  });
  render(
    <UpscaleComparison
      entries={[entry]}
      models={models}
      settings={deck.printSettings}
      activeModel={compactModel.id}
      onChoose={vi.fn()}
    />,
  );
  await user.click(screen.getByText("Compare upscale models"));
  const picker = screen.getByRole("button", { name: "Crop position" });
  expect(picker).toHaveAccessibleDescription(/50% across, 78% down/);
  picker.focus();
  await user.keyboard("{ArrowUp}");
  expect(picker).toHaveFocus();
  expect(await screen.findAllByText("12.5 ms")).toHaveLength(4);
  expect(calls).toEqual([
    expect.objectContaining({ position: { x: 0.5, y: 0.73 } }),
  ]);

  vi.spyOn(picker, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 20, 100, 200),
  );
  picker.setPointerCapture = vi.fn();
  fireEvent.pointerDown(picker, {
    button: 0,
    pointerId: 1,
    clientX: 60,
    clientY: 166,
  });
  fireEvent.pointerMove(picker, { pointerId: 1, clientX: 90, clientY: 70 });
  expect(calls).toHaveLength(1);
  fireEvent.pointerUp(picker, { pointerId: 1, clientX: 90, clientY: 70 });
  expect(await screen.findAllByText("25.0 ms")).toHaveLength(4);
  expect(calls[1]).toEqual(
    expect.objectContaining({ position: { x: 0.8, y: 0.25 } }),
  );
  expect(picker).toHaveAccessibleDescription(/80% across, 25% down/);

  fireEvent.pointerDown(picker, {
    button: 0,
    pointerId: 2,
    clientX: 110,
    clientY: 70,
  });
  fireEvent.pointerUp(picker, { pointerId: 2, clientX: 110, clientY: 70 });
  expect(await screen.findAllByText("37.5 ms")).toHaveLength(4);
  expect(picker).toHaveAccessibleDescription(/100% across, 25% down/);
  await user.keyboard("{ArrowRight}{ArrowRight}");
  expect(calls).toHaveLength(3);
  await user.keyboard("{ArrowLeft}");
  expect(await screen.findAllByText("50.0 ms")).toHaveLength(4);
  expect(calls[3]).toEqual(
    expect.objectContaining({ position: { x: 0.95, y: 0.25 } }),
  );
});

it("cancels comparison requests on cancel, restart and navigation out of print setup", async () => {
  const user = userEvent.setup();
  const started: unknown[] = [];
  const cancelled: unknown[] = [];
  window.history.replaceState(null, "", `/#/decks/${id}`);
  mockIPC((cmd, args) => {
    switch (cmd) {
      case "health":
        return { status: "ok", service: "@deckpress/desktop" };
      case "list_decks":
        return [deck];
      case "get_deck":
        return deck;
      case "begin_upscale_comparison":
        return null;
      case "compare_upscalers":
        started.push((args as { requestId: string }).requestId);
        return new Promise(() => {});
      case "cancel_upscale_comparison":
        cancelled.push((args as { requestId: string }).requestId);
        return null;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Print setup" }));
  await user.click(screen.getByText("Compare upscale models"));
  const renderCrops = () =>
    user.click(screen.getByRole("button", { name: "Render text crops" }));
  await renderCrops();
  await waitFor(() => expect(started).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Cancel render" }));
  await waitFor(() => expect(cancelled).toEqual(started));
  const comparisonStatus = screen.getByRole("status", {
    name: "Upscale comparison status",
  });
  expect(comparisonStatus).toHaveTextContent("Comparison cancelled");
  expect(comparisonStatus).toBeVisible();
  await renderCrops();
  expect(comparisonStatus).not.toHaveTextContent("Comparison cancelled");
  await waitFor(() => expect(started).toHaveLength(2));
  await user.click(screen.getByRole("button", { name: "Restart render" }));
  await waitFor(() => expect(started).toHaveLength(3));
  expect(cancelled).toEqual(started.slice(0, 2));
  await user.click(screen.getByRole("button", { name: "Deck editor" }));
  await waitFor(() => expect(cancelled).toEqual(started));
  expect(new Set(started).size).toBe(3);
  expect(screen.queryByText("Compare upscale models")).not.toBeInTheDocument();
});

it("opens Settings Models from the missing-model link using the keyboard", async () => {
  const user = userEvent.setup();
  vi.mocked(api.settings).mockResolvedValue({
    ...(await api.settings()),
    models: [
      compactModel,
      {
        ...compactModel,
        id: "realesrgan-x4plus",
        tier: "quality",
        installed: false,
      },
    ],
  });
  window.history.replaceState(null, "", `/#/decks/${id}`);
  mockIPC((cmd) => {
    switch (cmd) {
      case "health":
        return { status: "ok", service: "@deckpress/desktop" };
      case "list_decks":
        return [deck];
      case "get_deck":
        return deck;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Print setup" }));
  await user.click(screen.getByText("Compare upscale models"));
  await user.click(screen.getByLabelText("Comparison card"));
  await user.tab();
  await user.tab();
  expect(screen.getByRole("button", { name: "Crop position" })).toHaveFocus();
  await user.tab();
  await user.tab();
  await user.tab();
  const link = await screen.findByRole("link", {
    name: "Download in Settings",
  });
  expect(link).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Local AI upscaling" }),
    ).toHaveFocus(),
  );
  expect(window.location.hash).toBe("#/settings/models");
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
  expect(screen.getByAltText("Preview: Lightning Bolt")).toHaveAttribute(
    "src",
    expect.stringContaining("alternate.png"),
  );
  expect(apply).not.toHaveBeenCalled();
  await user.selectOptions(screen.getByLabelText("Your rating"), "5");
  await waitFor(() =>
    expect(preference).toHaveBeenCalledWith(
      alternate.id,
      expect.objectContaining({ rating: 5 }),
    ),
  );
  await user.selectOptions(screen.getByLabelText("Apply to"), "one");
  expect(
    screen.getByRole("button", { name: "Apply" }),
  ).toHaveAccessibleDescription("1 of 4 copies in this entry");
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

const previewButton = { name: "Select Mystical Archive 42 by Anato Finnstark" };
const promptName = { name: "Discard art preview?" };
const sideEntry: DeckEntry = {
  ...entry,
  id: "92944e53-d478-4a0d-b7df-f8bef0b44e4a",
  quantity: 2,
  zone: "side",
};
const otherEntry: DeckEntry = {
  ...entry,
  id: "399515f7-7007-497d-91dc-be16d8e409a4",
  card: {
    ...entry.card,
    name: "Shock",
    oracleId: "399515f7-7007-497d-91dc-be16d8e409a4",
    faces: [{ ...original, id: "scryfall:shock", name: "Shock" }],
  },
};
const pickerDeck = { ...deck, entries: [otherEntry, entry, sideEntry] };

function mockPickerArt(prints = [original, alternate, community]) {
  vi.spyOn(api, "uploads").mockResolvedValue([]);
  vi.spyOn(api, "preferences").mockResolvedValue({
    preferences: {},
    usage: {},
  });
  return vi
    .spyOn(api, "art")
    .mockImplementation(async (provider, _, __, ___, page) => ({
      items: provider === "scryfall" ? prints : [],
      page,
      hasMore: false,
      total: provider === "scryfall" ? prints.length : 0,
    }));
}

const secondArtDeck = {
  ...deck,
  id: "053d7e52-19e2-451c-a568-0b49c2adc544",
  name: "Second deck",
};

async function openArtStudio(user: ReturnType<typeof userEvent.setup>) {
  window.history.replaceState(null, "", `/#/decks/${id}`);
  mockPickerArt([original, alternate]);
  vi.spyOn(api, "decks").mockResolvedValue([deck, secondArtDeck]);
  vi.spyOn(api, "deck").mockImplementation(async (deckId) =>
    deckId === id ? deck : secondArtDeck,
  );
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Art studio" }));
  return screen.findByRole("button", previewButton);
}

it("keeps an unapplied Art Studio pick guarded through policy Keep, Apply, and Undo", async () => {
  const user = userEvent.setup();
  const pick = await openArtStudio(user);
  const policyArt = {
    ...original,
    id: "scryfall:policy",
    source: "Policy set",
  };
  const previewId = crypto.randomUUID();
  vi.spyOn(api, "previewArtPolicy").mockResolvedValue({
    previewId,
    canApply: true,
    changes: [
      {
        entryId: entry.id,
        name: entry.card.name,
        quantity: entry.quantity,
        before: original,
        after: policyArt,
        kind: "changed",
        reason: "Latest printing",
      },
    ],
  });
  const apply = vi.spyOn(api, "applyArtPreview").mockResolvedValue({
    ...deck,
    revision: deck.revision + 1,
    artPolicy: { kind: "latest" },
    entries: [{ ...entry, policyArt: [policyArt] }],
  });
  const undo = vi
    .spyOn(api, "undoArtChange")
    .mockResolvedValue({ ...deck, revision: deck.revision + 2 });
  const openSettings = async () => {
    await user.click(screen.getByRole("button", { name: "Deck settings" }));
    return within(screen.getByRole("dialog", { name: "Deck settings" }));
  };
  const openPolicy = async (settings: ReturnType<typeof within>) => {
    await user.click(
      settings.getByRole("button", { name: "Preview art policy" }),
    );
    expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
    return within(
      await screen.findByRole("dialog", { name: "Preview art changes" }),
    );
  };
  const editor = screen.getByRole("button", { name: "Deck editor" });

  await user.click(pick);
  const settings = await openSettings();
  let policy = await openPolicy(settings);
  await user.click(
    policy.getByRole("button", { name: "Keep current choices" }),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(pick).toHaveAttribute("aria-pressed", "true");
  policy = await openPolicy(settings);
  await user.click(policy.getByRole("button", { name: "Apply art changes" }));
  expect(apply).toHaveBeenCalledWith(deck.id, deck.revision, previewId);
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  await user.click(settings.getByRole("button", { name: "Close dialog" }));

  await user.click(editor);
  await user.click(
    within(screen.getByRole("dialog", promptName)).getByRole("button", {
      name: "Keep preview",
    }),
  );
  expect(pick).toHaveAttribute("aria-pressed", "true");

  const reopened = await openSettings();
  await user.click(
    reopened.getByRole("button", { name: "Undo last art change" }),
  );
  expect(undo).toHaveBeenCalledWith(deck.id, deck.revision + 1);
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  await user.click(reopened.getByRole("button", { name: "Close dialog" }));
  await user.click(editor);
  expect(screen.getByRole("dialog", promptName)).toBeVisible();
  expect(pick).toHaveAttribute("aria-pressed", "true");
});

it("adds one editions message to the status already mounted in the workspace", async () => {
  const user = userEvent.setup();
  window.history.replaceState(null, "", `/#/decks/${id}`);
  vi.spyOn(api, "deck").mockResolvedValue(deck);
  const art = mockPickerArt([original]);
  const editions = Promise.withResolvers<Awaited<ReturnType<typeof api.art>>>();
  art.mockReturnValue(editions.promise);
  renderWithClient(<App />);
  const studio = await screen.findByRole("button", { name: "Art studio" });
  const status = screen.getByRole("status", { name: "Art editions loading" });
  expect(status).toBeEmptyDOMElement();

  await user.click(studio);
  expect(status).toHaveTextContent("Finding editions…");
  expect(status.children).toHaveLength(1);
  expect(document.querySelector(".loading")).toHaveTextContent(
    "Finding editions…",
  );
  editions.resolve({ items: [original], page: 1, hasMore: false, total: 1 });
  await waitFor(() => expect(status).toBeEmptyDOMElement());
  expect(screen.getByRole("status", { name: "Art editions loading" })).toBe(
    status,
  );
});

it.each([
  [
    "Deck editor",
    () => screen.findByRole("searchbox", { name: "Find a card" }),
  ],
  ["Print setup", () => screen.findByRole("button", { name: "Other exports" })],
  [
    "Back to decks",
    () => screen.findByRole("heading", { name: "Decks", level: 1 }),
  ],
  [
    "Second deck",
    () => screen.findByRole("heading", { name: "Second deck", level: 1 }),
  ],
  [
    "Print jobs",
    () => screen.findByRole("heading", { name: "Print jobs", level: 1 }),
  ],
  ["Decks", () => screen.findByRole("heading", { name: "Decks", level: 1 })],
  [
    "Art sources",
    () => screen.findByRole("heading", { name: "Art sources", level: 1 }),
  ],
  [
    "Discover",
    () => screen.findByRole("heading", { name: "Discover decks", level: 1 }),
  ],
  [
    "Deck builder",
    () => screen.findByRole("heading", { name: "Deck builder", level: 1 }),
  ],
  [
    "Settings",
    () => screen.findByRole("heading", { name: "Settings", level: 1 }),
  ],
] as const)("guards the %s exit from Art studio", async (name, destination) => {
  const user = userEvent.setup();
  const preview = await openArtStudio(user);
  await user.click(preview);
  const trigger = await screen.findByRole("button", { name });
  await user.click(trigger);
  const prompt = screen.getByRole("dialog", promptName);
  expect(prompt).toHaveAccessibleDescription(/leave Art studio/);
  const keep = within(prompt).getByRole("button", { name: "Keep preview" });
  const discard = within(prompt).getByRole("button", { name: "Discard" });
  discard.focus();
  await user.tab();
  expect(keep).toHaveFocus();
  await user.click(keep);
  expect(prompt).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(preview).toHaveAttribute("aria-pressed", "true");

  await user.click(trigger);
  fireEvent(
    screen.getByRole("dialog", promptName),
    new Event("cancel", { cancelable: true }),
  );
  expect(trigger).toHaveFocus();
  expect(preview).toHaveAttribute("aria-pressed", "true");

  await user.click(trigger);
  await user.click(
    within(screen.getByRole("dialog", promptName)).getByRole("button", {
      name: "Discard",
    }),
  );
  expect(await destination()).toBeVisible();
  expect(preview).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  expect(
    name === "Back to decks" ? screen.getByRole("main") : trigger,
  ).toHaveFocus();
});

it("keeps, then discards a preview when Tauri requests window close", async () => {
  const user = userEvent.setup();
  const commands = vi.fn((command: string) =>
    command === "plugin:window|is_fullscreen" ? false : [],
  );
  mockWindows("main");
  mockIPC(commands, { shouldMockEvents: true });
  const preview = await openArtStudio(user);
  await user.click(preview);

  await act(() => emit(TauriEvent.WINDOW_CLOSE_REQUESTED));
  await user.click(screen.getByRole("button", { name: "Keep preview" }));
  expect(preview).toHaveFocus();
  expect(preview).toHaveAttribute("aria-pressed", "true");
  expect(commands).not.toHaveBeenCalledWith("plugin:window|destroy", {
    label: "main",
  });

  await act(() => emit(TauriEvent.WINDOW_CLOSE_REQUESTED));
  await user.click(
    within(screen.getByRole("dialog", promptName)).getByRole("button", {
      name: "Discard",
    }),
  );
  await waitFor(() =>
    expect(commands).toHaveBeenCalledWith("plugin:window|destroy", {
      label: "main",
    }),
  );
});

it("navigates immediately when there is no preview to discard", async () => {
  const user = userEvent.setup();
  await openArtStudio(user);
  await user.click(screen.getByRole("button", { name: "Deck editor" }));
  expect(
    await screen.findByRole("searchbox", { name: "Find a card" }),
  ).toBeVisible();
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Art studio" }));
  await user.click(screen.getByRole("button", { name: "Back to decks" }));
  expect(
    await screen.findByRole("heading", { name: "Decks", level: 1 }),
  ).toBeVisible();
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
});

it("protects the preview on hash navigation and Settings shortcut, but not on sidebar toggle", async () => {
  const user = userEvent.setup();
  const preview = await openArtStudio(user);
  await user.click(preview);
  await user.keyboard("{Control>}b{/Control}");
  expect(screen.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  expect(preview).toHaveAttribute("aria-pressed", "true");
  await user.keyboard("{Control>}b{/Control}");

  act(() => {
    window.history.replaceState(null, "", "#/jobs");
    window.dispatchEvent(new Event("hashchange"));
  });
  const prompt = await screen.findByRole("dialog", promptName);
  expect(window.location.hash).toBe(`#/decks/${id}`);
  await user.click(
    within(prompt).getByRole("button", { name: "Keep preview" }),
  );
  expect(preview).toHaveFocus();
  expect(preview).toHaveAttribute("aria-pressed", "true");

  await user.keyboard("{Control>},{/Control}");
  await user.click(
    within(await screen.findByRole("dialog", promptName)).getByRole("button", {
      name: "Discard",
    }),
  );
  expect(
    await screen.findByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  expect(screen.getByRole("main")).toHaveFocus();
});

it("shows scan quality and only previews the better printing when prefer high-res is enabled", async () => {
  const user = userEvent.setup();
  const key = "deckpress.prefer-high-res";
  const low = {
    ...alternate,
    illustrationId: id,
    scanQuality: "lowres" as const,
  };
  const high = {
    ...low,
    id: "scryfall:better",
    source: "Better edition",
    scanQuality: "highres_scan" as const,
  };
  mockPickerArt([low, high]);
  const betterScan = vi.spyOn(api, "betterScan").mockResolvedValue(high);
  const renderPicker = () =>
    renderWithClient(
      <ArtPicker
        deck={pickerDeck}
        entry={entry}
        onSelect={vi.fn()}
        onApply={vi.fn()}
      />,
    );
  try {
    const view = renderPicker();
    const tile = await screen.findByRole("button", previewButton);
    expect(tile).toHaveAccessibleDescription(/Low-res scan/);
    expect(within(tile).getByText("Low-res scan")).toBeVisible();
    await user.click(tile);
    expect(tile).toHaveAttribute("aria-pressed", "true");
    expect(betterScan).not.toHaveBeenCalled();
    const toggle = screen.getByRole("checkbox", { name: "Prefer high-res" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    view.unmount();
    renderPicker();
    expect(
      screen.getByRole("checkbox", { name: "Prefer high-res" }),
    ).toBeChecked();
    await user.click(await screen.findByRole("button", previewButton));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Select Better edition/ }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    expect(betterScan).toHaveBeenCalledExactlyOnceWith(low, id, 0);
    expect(screen.getByText("High-res scan")).toBeVisible();
  } finally {
    localStorage.removeItem(key);
  }
});

it("lists images below 300 effective DPI with scan quality in print preflight", async () => {
  const user = userEvent.setup();
  const low = { ...original, scanQuality: "lowres" as const };
  const value = { ...deck, entries: [{ ...entry, selectedArt: low }] };
  const check = vi
    .spyOn(api, "sourceDpi")
    .mockResolvedValue([{ effectiveDpi: 243.8, belowUpscaleThreshold: true }]);
  renderWithClient(
    <PrintSetup
      deck={value}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onJobs={vi.fn()}
      mpcExport={{ busy: false, run: () => {} }}
    />,
  );
  expect(check).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Check source DPI" }));
  expect(
    await screen.findByText("1 unique images below 300 effective DPI."),
  ).toBeVisible();
  const row = screen.getByText(/243 effective DPI — below 300/);
  expect(row).toHaveTextContent("Lightning Bolt · Magic 2010 146");
  expect(within(row).getByText("Low-res scan")).toBeVisible();
  expect(row).toHaveTextContent("AI upscaling: off");
  expect(check).toHaveBeenCalledExactlyOnceWith(
    [low],
    expect.objectContaining({ cardWidthMm: 63, cardHeightMm: 88 }),
  );
});

it("waits for a recheck after the print settings change", async () => {
  const user = userEvent.setup();
  const check = vi
    .spyOn(api, "sourceDpi")
    .mockResolvedValue([{ effectiveDpi: 330, belowUpscaleThreshold: true }]);
  function PrintHarness() {
    const [value, setValue] = useState(deck);
    return (
      <PrintSetup
        deck={value}
        onChange={setValue}
        onSave={vi.fn()}
        onJobs={vi.fn()}
        mpcExport={{ busy: false, run: () => {} }}
      />
    );
  }
  renderWithClient(<PrintHarness />);
  await user.click(screen.getByRole("button", { name: "Check source DPI" }));
  expect(
    await screen.findByText("0 unique images below 300 effective DPI."),
  ).toBeVisible();
  await user.selectOptions(screen.getByLabelText("Resolution"), "1200");
  expect(screen.getByText(/results are stale/)).toBeVisible();
  expect(
    screen.queryByText("0 unique images below 300 effective DPI."),
  ).not.toBeInTheDocument();
  expect(check).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Recheck source DPI" }));
  expect(
    await screen.findByText("0 unique images below 300 effective DPI."),
  ).toBeVisible();
  expect(check).toHaveBeenCalledTimes(2);
  expect(check).toHaveBeenLastCalledWith(
    [original],
    expect.objectContaining({ dpi: 1200 }),
  );
});

it("labels cached Scryfall pixel dimensions separately from format estimates at the selected trim", async () => {
  const print = artSchema.parse({ ...alternate, dpi: 0 });
  mockPickerArt([original, print, community]);
  const pickerDpi = vi
    .spyOn(api, "pickerDpi")
    .mockImplementation(async (arts) =>
      arts.map((art) =>
        art.id === original.id
          ? { effectiveDpi: 330.16, estimated: false }
          : { effectiveDpi: 305.9, estimated: true },
      ),
    );
  const printSettings = {
    ...deck.printSettings,
    cardWidthMm: 80,
    cardHeightMm: 80,
  };
  renderWithClient(
    <ArtPicker
      deck={{ ...deck, printSettings }}
      entry={entry}
      onSelect={vi.fn()}
      onApply={vi.fn()}
    />,
  );
  const originalTile = await screen.findByRole("button", {
    name: /Select Magic 2010/,
  });
  const alternateTile = await screen.findByRole("button", {
    name: /Select Mystical Archive/,
  });
  expect(
    await within(originalTile).findByText("330 effective DPI"),
  ).toBeVisible();
  expect(
    await within(alternateTile).findByText("~305 DPI (estimated)"),
  ).toBeVisible();
  expect(alternateTile).toHaveAccessibleDescription(/305 DPI \(estimated\)/);
  expect(pickerDpi).toHaveBeenLastCalledWith(expect.any(Array), printSettings);
});

it("shows MPC Autofill DPI on its picker badge", async () => {
  mockPickerArt();
  vi.mocked(api.art).mockImplementation(async (provider, _, __, ___, page) => ({
    items: provider === "mpc" ? [community] : [],
    total: provider === "mpc" ? 1 : 0,
    page,
    hasMore: false,
  }));
  renderWithClient(
    <ArtPicker
      deck={deck}
      entry={entry}
      onSelect={vi.fn()}
      onApply={vi.fn()}
    />,
  );
  const tile = await screen.findByRole("button", { name: /Select Creator/ });
  expect(tile).toHaveAccessibleDescription("MPC · 1200 DPI");
  expect(within(tile).getByText("MPC · 1200 DPI")).toBeVisible();
});

it("separates MPC DPI from measured source DPI and reports the selected AI model per image", async () => {
  const user = userEvent.setup();
  const missing = {
    ...compactModel,
    id: "missing-model",
    name: "Missing model",
    installed: false,
  };
  vi.mocked(api.settings).mockResolvedValue({
    ...(await api.settings()),
    models: [compactModel, missing],
  });
  const model = compactModel.name;
  vi.spyOn(api, "sourceDpi").mockResolvedValue([
    { effectiveDpi: 245.6, belowUpscaleThreshold: true },
    { effectiveDpi: 296.1, belowUpscaleThreshold: false },
  ]);
  function PrintHarness() {
    const [value, setValue] = useState<Deck>({
      ...deck,
      entries: [
        { ...entry, selectedArt: community },
        { ...otherEntry, selectedArt: original },
      ],
    });
    return (
      <PrintSetup
        deck={value}
        onChange={setValue}
        onSave={vi.fn()}
        onJobs={vi.fn()}
        mpcExport={{ busy: false, run: () => {} }}
      />
    );
  }
  renderWithClient(<PrintHarness />);
  await user.click(screen.getByRole("button", { name: "Check source DPI" }));
  const mpc = await screen.findByText(/245 effective DPI/);
  const scan = screen.getByText(/296 effective DPI/);
  expect(within(mpc).getByText("MPC · 1200 DPI")).toBeVisible();
  expect(mpc).toHaveTextContent("AI upscaling: off");
  await user.click(
    screen.getByRole("checkbox", { name: "Use local AI upscaling" }),
  );
  expect(mpc).toHaveTextContent(`AI upscaling: will apply — ${model}`);
  expect(scan).toHaveTextContent(
    `AI upscaling: not needed at 800 DPI (${model})`,
  );
  await user.selectOptions(screen.getByLabelText("Model"), missing.id);
  expect(mpc).toHaveTextContent(
    "AI upscaling: blocked — download Missing model",
  );
});

async function openGuardedPolicy(user: ReturnType<typeof userEvent.setup>) {
  window.history.replaceState(null, "", `/#/decks/${id}`);
  vi.spyOn(api, "deck").mockResolvedValue(deck);
  vi.spyOn(api, "decks").mockResolvedValue([deck]);
  const preview = vi.spyOn(api, "previewArtPolicy").mockResolvedValue({
    previewId: crypto.randomUUID(),
    canApply: true,
    changes: [],
  });
  const apply = vi.spyOn(api, "applyArtPreview");
  const save = vi.spyOn(api, "saveDeck");
  renderWithClient(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Deck settings" }),
  );
  const opener = screen.getByRole("button", { name: "Preview art policy" });
  await user.click(opener);
  const review = screen.getByRole("dialog", { name: "Preview art changes" });
  await waitFor(() =>
    expect(
      within(review).getByRole("button", { name: "Apply art changes" }),
    ).toBeEnabled(),
  );
  return { review, preview, apply, save, opener };
}

it("traps policy exit focus and keeps the same review on Keep and Escape", async () => {
  const user = userEvent.setup();
  const { review, preview, apply, save } = await openGuardedPolicy(user);
  const reviewKeep = within(review).getByRole("button", {
    name: "Keep current choices",
  });
  reviewKeep.focus();
  await user.keyboard("{Control>}b{/Control}");
  expect(screen.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  await user.keyboard("{Control>}b{/Control}");

  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);

  const leave = async () => {
    await user.keyboard("{Control>},{/Control}");
    return screen.getByRole("dialog", promptName);
  };
  let prompt = await leave();
  const keep = within(prompt).getByRole("button", { name: "Keep preview" });
  const discard = within(prompt).getByRole("button", { name: "Discard" });
  discard.focus();
  await user.tab();
  expect(keep).toHaveFocus();
  await user.tab({ shift: true });
  expect(discard).toHaveFocus();
  await user.click(keep);
  expect(reviewKeep).toHaveFocus();

  prompt = await leave();
  fireEvent(prompt, new Event("cancel", { cancelable: true }));
  expect(reviewKeep).toHaveFocus();
  expect(preview).toHaveBeenCalledOnce();
  expect(review).toBeVisible();

  prompt = await leave();
  await user.click(within(prompt).getByRole("button", { name: "Discard" }));
  expect(
    await screen.findByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  expect(review).not.toBeInTheDocument();
  expect(screen.getByRole("main")).toHaveFocus();
  expect(apply).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it.each(["hash", "new deck shortcut", "sidebar", "workspace tab"])(
  "guards a policy-only preview from %s navigation",
  async (exit) => {
    const user = userEvent.setup();
    const { review, apply, opener } = await openGuardedPolicy(user);
    if (exit === "hash") {
      act(() => {
        window.history.replaceState(null, "", "#/jobs");
        window.dispatchEvent(new Event("hashchange"));
      });
    } else if (exit === "new deck shortcut") {
      await user.keyboard("{Control>}n{/Control}");
    } else {
      fireEvent.click(
        screen.getByRole("button", {
          name: exit === "sidebar" ? "Settings" : "Print setup",
        }),
      );
    }
    const prompt = screen.getByRole("dialog", promptName);
    expect(window.location.hash).toBe(`#/decks/${id}`);
    await user.click(within(prompt).getByRole("button", { name: "Discard" }));
    expect(review).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
    if (exit === "workspace tab") {
      expect(
        screen.getByRole("button", { name: "Print setup" }),
      ).toHaveAttribute("aria-current", "page");
      expect(opener).toHaveFocus();
    }
  },
);

it("guards a policy-only preview when Tauri requests window close", async () => {
  const user = userEvent.setup();
  const commands = vi.fn((command: string) =>
    command === "plugin:window|is_fullscreen" ? false : [],
  );
  mockWindows("main");
  mockIPC(commands, { shouldMockEvents: true });
  const { review, apply, save } = await openGuardedPolicy(user);
  const keep = within(review).getByRole("button", {
    name: "Keep current choices",
  });
  keep.focus();
  await act(() => emit(TauriEvent.WINDOW_CLOSE_REQUESTED));
  fireEvent(
    screen.getByRole("dialog", promptName),
    new Event("cancel", { cancelable: true }),
  );
  expect(keep).toHaveFocus();
  expect(commands).not.toHaveBeenCalledWith("plugin:window|destroy", {
    label: "main",
  });
  await act(() => emit(TauriEvent.WINDOW_CLOSE_REQUESTED));
  await user.click(
    within(screen.getByRole("dialog", promptName)).getByRole("button", {
      name: "Discard",
    }),
  );
  await waitFor(() =>
    expect(commands).toHaveBeenCalledWith("plugin:window|destroy", {
      label: "main",
    }),
  );
  expect(review).not.toBeInTheDocument();
  expect(apply).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
it("shows original, saved and preview art separately, even when saved art is outside the results", async () => {
  const user = userEvent.setup();
  mockPickerArt([original, alternate]);
  const savedEntry = { ...entry, selectedArt: community };
  const savedDeck = { ...deck, entries: [savedEntry] };
  const apply = vi.fn(async (value: Deck) => value);
  function Picker() {
    const [current, setCurrent] = useState<Deck>(savedDeck);
    return (
      <ArtPicker
        deck={current}
        entry={current.entries[0] ?? savedEntry}
        onSelect={vi.fn()}
        onApply={async (value) => {
          const result = await apply(value);
          setCurrent(result);
          return result;
        }}
      />
    );
  }
  renderWithClient(<Picker />);
  const savedTile = screen.getByRole("button", { name: /Select Creator/ });
  expect(savedTile).toHaveAccessibleName(/ — Saved, Preview$/);
  const preview = await screen.findByRole("button", previewButton);
  await user.click(preview);
  expect(savedTile).toHaveAccessibleName(/ — Saved$/);
  expect(preview).toHaveAccessibleName(/ — Preview$/);
  expect(
    screen.getByRole("button", { name: /Select Magic 2010/ }),
  ).toHaveAccessibleName(/ — Original$/);
  expect(
    within(screen.getByRole("region", { name: "Saved art" })).getByText(
      "Creator",
    ),
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Original art" })).getByText(
      "Magic 2010",
    ),
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Preview art" })).getByText(
      "Mystical Archive",
    ),
  ).toBeVisible();
  expect(apply).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(preview).toHaveAccessibleName(/ — Saved, Preview$/);
  const announcement = screen.getByText("Applied: Mystical Archive 42");
  expect(announcement.closest('[role="status"]')).not.toBeNull();
  expect(
    screen.queryByRole("region", { name: "Saved art" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(screen.getByText("Applied: Mystical Archive 42")).toBe(announcement);
});

it("selects the saved copy after One copy only, then advances without a discard dialog", async () => {
  const user = userEvent.setup();
  let stored = { ...deck, entries: [entry, otherEntry, sideEntry] };
  const saves = vi.fn();
  mockPickerArt([original, alternate]);
  mockIPC((cmd, args) => {
    switch (cmd) {
      case "health":
        return { status: "ok", service: "@deckpress/desktop" };
      case "list_decks":
        return [stored];
      case "get_deck":
        return stored;
      case "save_deck":
        stored = deckSchema.parse((args as { deck: unknown }).deck);
        saves(stored);
        return stored;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  await user.click(
    (
      await screen.findAllByRole("button", {
        name: "Choose art for Lightning Bolt",
      })
    )[0] as HTMLElement,
  );
  await user.click(await screen.findByRole("button", previewButton));
  await user.selectOptions(screen.getByLabelText("Apply to"), "one");
  await user.click(screen.getByRole("button", { name: "Apply" }));

  expect(saves).toHaveBeenCalledOnce();
  expect(
    stored.entries
      .slice(0, 2)
      .map(({ quantity, selectedArt }) => [quantity, selectedArt?.id]),
  ).toEqual([
    [3, undefined],
    [1, alternate.id],
  ]);
  expect(
    await screen.findByRole("button", {
      name: "Edit art 2: Lightning Bolt",
      current: true,
    }),
  ).toBeVisible();
  expect(
    await screen.findByRole("button", {
      name: `${previewButton.name} — Saved, Preview`,
    }),
  ).toBeVisible();
  const announcement = screen.getByText("Applied: Mystical Archive 42");
  await user.click(screen.getByRole("button", { name: "Next card" }));
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Shock" })).toHaveFocus();
  expect(saves).toHaveBeenCalledOnce();
  expect(screen.getByText("Applied: Mystical Archive 42")).toBe(announcement);
});

it.each([
  ["entry", "4 copies in this entry", undefined],
  ["deck", "4 copies here · 6 copies across all boards", alternate.id],
] as const)(
  "applies the %s scope without changing quantities or unrelated cards",
  async (scope, impact, sideArt) => {
    const user = userEvent.setup();
    mockPickerArt([original, alternate]);
    const apply = vi.fn(async (value: Deck) => value);
    renderWithClient(
      <ArtPicker
        deck={pickerDeck}
        entry={entry}
        onSelect={vi.fn()}
        onApply={apply}
      />,
    );
    await user.click(await screen.findByRole("button", previewButton));
    await user.selectOptions(screen.getByLabelText("Apply to"), scope);
    const button = screen.getByRole("button", { name: "Apply" });
    expect(button).toHaveAccessibleDescription(impact);
    await user.click(button);
    expect(apply.mock.calls[0]?.[0].entries).toEqual([
      otherEntry,
      { ...entry, selectedArt: alternate },
      { ...sideEntry, selectedArt: sideArt ? alternate : null },
    ]);
  },
);

it.each([
  ["Next card", sideEntry.id],
  ["Previous card", otherEntry.id],
  ["Edit art 1: Shock", otherEntry.id],
] as const)(
  "guards %s until the user discards the preview",
  async (name, target) => {
    const user = userEvent.setup();
    mockPickerArt([original, alternate]);
    const apply = vi.fn(async (value: Deck) => value);
    const select = vi.fn();
    renderWithClient(
      <ArtPicker
        deck={pickerDeck}
        entry={entry}
        onSelect={select}
        onApply={apply}
      />,
    );
    const preview = await screen.findByRole("button", previewButton);
    await user.click(preview);
    const nav = screen.getByRole("button", { name });
    nav.focus();
    await user.keyboard("{Enter}");
    const prompt = screen.getByRole("dialog", promptName);
    expect(select).not.toHaveBeenCalled();
    await user.click(within(prompt).getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
    expect(preview).toHaveAttribute("aria-pressed", "true");
    await user.click(nav);
    await user.click(
      within(screen.getByRole("dialog", promptName)).getByRole("button", {
        name: "Discard",
      }),
    );
    expect(select).toHaveBeenCalledExactlyOnceWith(target);
    expect(apply).not.toHaveBeenCalled();
  },
);

it.each([
  ["Front", "Back"],
  ["Back", "Front"],
] as const)(
  "confirms a face switch from %s to %s only with an unapplied preview",
  async (from, to) => {
    const user = userEvent.setup();
    mockPickerArt([original, alternate]);
    const apply = vi.fn(async (value: Deck) => value);
    const twoSided = {
      ...entry,
      card: {
        ...entry.card,
        faces: [original, { ...original, id: "scryfall:original-back" }],
      },
    };
    renderWithClient(
      <ArtPicker
        deck={{ ...deck, entries: [twoSided] }}
        entry={twoSided}
        onSelect={vi.fn()}
        onApply={apply}
      />,
    );
    const face = (name: string) => screen.getByRole("button", { name });
    if (from === "Back") await user.click(face(from));
    expect(face(from)).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();

    const preview = await screen.findByRole("button", previewButton);
    await user.click(preview);
    await user.click(face(from));
    expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();

    const trigger = face(to);
    await user.click(trigger);
    const prompt = screen.getByRole("dialog", promptName);
    const keep = within(prompt).getByRole("button", { name: "Keep preview" });
    const discard = within(prompt).getByRole("button", { name: "Discard" });
    discard.focus();
    await user.tab();
    expect(keep).toHaveFocus();
    await user.tab({ shift: true });
    expect(discard).toHaveFocus();
    await user.click(keep);
    expect(prompt).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(face(from)).toHaveAttribute("aria-pressed", "true");
    expect(preview).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{Enter}");
    fireEvent(
      screen.getByRole("dialog", promptName),
      new Event("cancel", { cancelable: true }),
    );
    expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(face(from)).toHaveAttribute("aria-pressed", "true");
    expect(preview).toHaveAttribute("aria-pressed", "true");

    await user.click(trigger);
    await user.click(
      within(screen.getByRole("dialog", promptName)).getByRole("button", {
        name: "Discard",
      }),
    );
    expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
    expect(face(to)).toHaveAttribute("aria-pressed", "true");
    expect(face(to)).toHaveFocus();

    await user.click(face(from));
    expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
    expect(face(from)).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", previewButton)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(apply).not.toHaveBeenCalled();
  },
);

it("navigates without prompting for unchanged art and waits for Apply & next to save", async () => {
  const user = userEvent.setup();
  mockPickerArt([original, alternate]);
  const select = vi.fn();
  let finish: ((value: Deck) => void) | undefined;
  const apply = vi.fn(
    (_value: Deck) =>
      new Promise<Deck>((resolve) => {
        finish = resolve;
      }),
  );
  renderWithClient(
    <ArtPicker
      deck={pickerDeck}
      entry={entry}
      onSelect={select}
      onApply={apply}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Previous card" }));
  expect(select).toHaveBeenCalledExactlyOnceWith(otherEntry.id);
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  select.mockClear();
  await user.click(await screen.findByRole("button", previewButton));
  await user.click(
    screen.getByRole("button", { name: "Edit art 2: Lightning Bolt" }),
  );
  expect(select).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply & next" }));
  expect(apply).toHaveBeenCalledWith(
    expect.objectContaining({
      entries: [otherEntry, { ...entry, selectedArt: alternate }, sideEntry],
    }),
  );
  expect(select).not.toHaveBeenCalled();
  finish?.({
    ...pickerDeck,
    entries: [otherEntry, { ...entry, selectedArt: alternate }, sideEntry],
  });
  await waitFor(() =>
    expect(select).toHaveBeenCalledExactlyOnceWith(sideEntry.id),
  );
  expect(screen.queryByRole("dialog", promptName)).not.toBeInTheDocument();
  expect(
    screen.getByText("Applied: Mystical Archive 42").closest('[role="status"]'),
  ).not.toBeNull();
});

it("updates local matches without implying they are the paginated Scryfall total", async () => {
  const user = userEvent.setup();
  mockPickerArt().mockImplementation(async (provider, _, __, ___, page) => ({
    items:
      provider === "scryfall"
        ? page === 1
          ? [original, alternate]
          : [{ ...alternate, id: "scryfall:third" }]
        : [],
    page,
    hasMore: provider === "scryfall" && page === 1,
    total: provider === "scryfall" ? 8 : 0,
  }));
  renderWithClient(
    <ArtPicker
      deck={deck}
      entry={entry}
      onSelect={vi.fn()}
      onApply={vi.fn()}
    />,
  );
  expect(
    await screen.findByText(
      "2 matches in loaded results · 2 of 8 Scryfall prints loaded",
      { selector: "span.hint" },
    ),
  ).toBeVisible();
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Art match count" }),
    ).toHaveTextContent(
      "2 matches in loaded results · 2 of 8 Scryfall prints loaded",
    ),
  );
  await user.type(
    screen.getByRole("searchbox", {
      name: "Search set, artist, creator or tag",
    }),
    "Finnstark",
  );
  expect(
    screen.getByText(
      "1 match in loaded results · 2 of 8 Scryfall prints loaded",
      { selector: "span.hint" },
    ),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: /Load more Scryfall prints/ }),
  );
  expect(
    await screen.findByText(
      "2 matches in loaded results · 3 of 8 Scryfall prints loaded",
      { selector: "span.hint" },
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Load more Scryfall prints/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "My uploads" }));
  expect(
    screen.getByText("0 matches in loaded results", { selector: "span.hint" }),
  ).toBeVisible();
});

it.each([
  [3, "1 of 3 MPC results loaded"],
  [0, "1 MPC result loaded"],
])(
  "announces pagination once when the filter's match count stays zero (MPC total %i)",
  async (total, firstProgress) => {
    const user = userEvent.setup();
    mockPickerArt().mockImplementation(async (provider, _, __, ___, page) => ({
      items:
        provider === "mpc"
          ? [{ ...alternate, id: `mpc:${page}`, provider }]
          : [],
      page,
      hasMore: provider === "mpc" && page === 1,
      total: provider === "mpc" ? total : 0,
    }));
    renderWithClient(
      <ArtPicker
        deck={deck}
        entry={entry}
        onSelect={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    await user.type(
      screen.getByRole("searchbox", {
        name: "Search set, artist, creator or tag",
      }),
      "no matching artwork",
    );
    const status = screen.getByRole("status", { name: "Art match count" });
    await within(status).findByText(
      `0 matches in loaded results · ${firstProgress}`,
    );
    const announcements: string[] = [];
    const observer = new MutationObserver(() =>
      announcements.push(status.textContent ?? ""),
    );
    observer.observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    try {
      await user.click(
        screen.getByRole("button", { name: "Load more MPC art" }),
      );
      const secondSummary = `0 matches in loaded results · ${total ? "2 of 3" : "2"} MPC results loaded`;
      expect(
        await screen.findByText(secondSummary, { selector: "span.hint" }),
      ).toBeVisible();
      await within(status).findByText(secondSummary);
      expect(announcements).toEqual([secondSummary]);
    } finally {
      observer.disconnect();
    }
  },
);

it("debounces match announcements and does not repeat an unchanged count", async () => {
  mockPickerArt([original, alternate]);
  renderWithClient(
    <ArtPicker
      deck={deck}
      entry={entry}
      onSelect={vi.fn()}
      onApply={vi.fn()}
    />,
  );
  const status = screen.getByRole("status", { name: "Art match count" });
  await within(status).findByText("2 matches in loaded results", {
    exact: true,
  });
  const search = screen.getByRole("searchbox", {
    name: "Search set, artist, creator or tag",
  });
  const announcements: string[] = [];
  const observer = new MutationObserver(() =>
    announcements.push(status.textContent ?? ""),
  );
  observer.observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  vi.useFakeTimers();
  try {
    fireEvent.change(search, { target: { value: "no match" } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    fireEvent.change(search, { target: { value: "Finnstark" } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(announcements).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(announcements).toEqual(["1 match in loaded results"]);
    fireEvent.change(search, { target: { value: "FINNSTARK" } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(announcements).toEqual(["1 match in loaded results"]);
  } finally {
    vi.useRealTimers();
    observer.disconnect();
  }
});

it("does not show a zero total for providers with more results", async () => {
  mockPickerArt().mockResolvedValue({
    items: [],
    page: 1,
    hasMore: true,
    total: 0,
  });
  renderWithClient(
    <ArtPicker
      deck={deck}
      entry={entry}
      onSelect={vi.fn()}
      onApply={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "Load more Scryfall prints" }),
  ).toBeVisible();
  expect(
    await screen.findByRole("button", { name: "Load more MPC art" }),
  ).toBeVisible();
  expect(screen.queryByText(/0 total/)).not.toBeInTheDocument();
});

it.each([
  ["auto", undefined],
  ["0", 0],
  ["custom", 1.25],
] as const)(
  "uploads art with the %s source bleed setting",
  async (mode, bleedMm) => {
    const user = userEvent.setup();
    vi.spyOn(api, "art").mockResolvedValue({
      items: [],
      page: 1,
      hasMore: false,
      total: 0,
    });
    vi.spyOn(api, "uploads").mockResolvedValue([]);
    vi.spyOn(api, "preferences").mockResolvedValue({
      preferences: {},
      usage: {},
    });
    const uploaded = artSchema.parse({
      ...community,
      provider: "upload",
      bleedMm: bleedMm ?? 3.048,
    });
    const upload = vi.spyOn(api, "upload").mockResolvedValue(uploaded);
    renderWithClient(
      <ArtPicker
        deck={deck}
        entry={entry}
        onSelect={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Upload your own art" }),
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "Upload card art" }),
    );
    const input = dialog.getByLabelText("Existing bleed per side");
    expect(input).toHaveValue("auto");
    if (mode !== "auto") await user.selectOptions(input, mode);
    if (mode === "custom") {
      await user.type(
        dialog.getByLabelText("Custom bleed per side (mm)"),
        "1.25",
      );
    }
    const file = new File(["image"], "card.png", { type: "image/png" });
    await user.upload(dialog.getByLabelText(/Image · PNG/), file);
    const submit = dialog.getByRole("button", { name: "Upload & preview" });
    expect(submit).toBeEnabled();
    const form = submit.closest("form");
    if (!form) throw new Error("Upload form not found");
    fireEvent.submit(form);
    expect(upload).toHaveBeenCalledOnce();
    const [submitted, meta] = upload.mock.calls[0] ?? [];
    expect(submitted).toBe(file);
    if (bleedMm === undefined) expect(meta).not.toHaveProperty("bleedMm");
    else expect(meta).toHaveProperty("bleedMm", bleedMm);
  },
);

it("edits a saved upload with the keyboard and refreshes its trimmed preview", async () => {
  const user = userEvent.setup();
  const uploaded = artSchema.parse({
    ...community,
    id: "upload:1",
    imageUrl: "upload://a4f5c8d1-0903-40be-8f8c-e9dcb5aa7240",
    provider: "upload",
    bleedMm: 0,
  });
  const savedEntry = { ...entry, selectedArt: uploaded };
  const updated = { ...uploaded, bleedMm: 3.175, dpi: 300 };
  const onApply = vi.fn();
  const onUploadEdited = vi.fn();
  vi.spyOn(api, "art").mockResolvedValue({
    items: [],
    page: 1,
    hasMore: false,
    total: 0,
  });
  vi.spyOn(api, "uploads").mockResolvedValue([uploaded]);
  vi.spyOn(api, "preferences").mockResolvedValue({
    preferences: {},
    usage: {},
  });
  const get = vi.spyOn(api, "uploadBleed").mockResolvedValue(0);
  const update = vi.spyOn(api, "updateUploadBleed").mockResolvedValue(updated);
  renderWithClient(
    <ArtPicker
      deck={{ ...deck, entries: [savedEntry] }}
      entry={savedEntry}
      onSelect={vi.fn()}
      onApply={onApply}
      onUploadEdited={onUploadEdited}
    />,
  );
  const preview = within(screen.getByRole("region", { name: "Preview art" }));
  const previewName = `Preview: ${uploaded.name}`;
  const initialSrc = preview
    .getByRole("img", { name: previewName })
    .getAttribute("src");
  const edit = preview.getByRole("button", { name: "Edit source bleed" });
  edit.focus();
  await user.keyboard("{Enter}");
  expect(get).toHaveBeenCalledWith(uploaded.imageUrl);
  const dialog = within(
    await screen.findByRole("dialog", { name: "Edit source bleed" }),
  );
  const selector = dialog.getByRole("combobox", {
    name: "Existing bleed per side",
  });
  expect(selector).toHaveValue("0");
  await user.selectOptions(selector, "3.175");
  const save = dialog.getByRole("button", { name: "Save bleed" });
  save.focus();
  await user.keyboard("{Enter}");
  expect(update).toHaveBeenCalledWith(uploaded.imageUrl, 3.175);
  await waitFor(() => expect(onUploadEdited).toHaveBeenCalledWith(updated));
  const newSrc = preview
    .getByRole("img", { name: previewName })
    .getAttribute("src");
  expect(newSrc).not.toBe(initialSrc);
  expect(newSrc).toContain("upload-trim");
  expect(newSrc).toContain("3.175");
  expect(preview.getByText("3.175 mm")).toBeVisible();
  expect(preview.getByText("Saved")).toBeVisible();
  expect(onApply).not.toHaveBeenCalled();
});

it("backs up fresh upload bleed even if the Library list still has the old value", async () => {
  const user = userEvent.setup();
  const uploaded = artSchema.parse({
    ...community,
    id: "upload:1",
    imageUrl: "upload://a4f5c8d1-0903-40be-8f8c-e9dcb5aa7240",
    source: "My uploads",
    provider: "upload",
    bleedMm: 3.048,
  });
  const withBleed = (art: typeof uploaded) => ({
    ...deck,
    entries: [{ ...entry, selectedArt: art }],
  });
  const cached = withBleed(uploaded);
  const updated = { ...uploaded, bleedMm: 3.175 };
  let stored = cached;
  const saveText = vi.fn();
  const mpc = { ...community, thumbnailUrl: community.imageUrl, bleedMm: 3 };
  const list = vi.spyOn(api, "decks").mockResolvedValue([cached]);
  const read = vi.spyOn(api, "deck").mockImplementation(async () => stored);
  vi.spyOn(api, "art").mockImplementation(async (provider) => ({
    items: provider === "mpc" ? [mpc] : [],
    page: 1,
    hasMore: false,
    total: 0,
  }));
  vi.spyOn(api, "uploads").mockResolvedValue([uploaded]);
  vi.spyOn(api, "preferences").mockResolvedValue({
    preferences: {},
    usage: {},
  });
  vi.spyOn(api, "uploadBleed").mockResolvedValue(null);
  vi.spyOn(api, "updateUploadBleed").mockImplementation(async () => {
    stored = withBleed(updated);
    return updated;
  });
  mockIPC((cmd, args) => {
    if (cmd === "export_file_name") return exportFileName(args);
    if (cmd === "plugin:dialog|save") return "/chosen/burn.deckpress.json";
    if (cmd === "save_text") return saveText(args);
    return [];
  });
  renderWithClient(<App />);
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  const openTile = await screen.findByRole("button", {
    name: "Choose art for Lightning Bolt",
  });
  expect(within(openTile).getByRole("img")).toHaveAttribute(
    "src",
    uploadTrimSrc(uploaded, true),
  );
  await user.click(openTile);
  const gridOption = () =>
    screen.getByRole("img", { name: `${uploaded.name}, ${uploaded.source}` });
  expect(
    await screen.findByRole("img", { name: `${mpc.name}, ${mpc.source}` }),
  ).toHaveAttribute("src", imageSrc(mpc.thumbnailUrl));
  expect(
    screen.getByRole("img", { name: `${original.name}, ${original.source}` }),
  ).toHaveAttribute("src", imageSrc(original.thumbnailUrl));
  expect(gridOption()).toHaveAttribute("src", uploadTrimSrc(uploaded, true));
  const preview = within(screen.getByRole("region", { name: "Preview art" }));
  await user.click(preview.getByRole("button", { name: "Edit source bleed" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Edit source bleed" }),
  );
  await user.selectOptions(
    dialog.getByRole("combobox", { name: "Existing bleed per side" }),
    "3.175",
  );
  const listCalls = list.mock.calls.length;
  await user.click(dialog.getByRole("button", { name: "Save bleed" }));
  expect(await preview.findByText("3.175 mm")).toBeVisible();
  expect(gridOption()).toHaveAttribute("src", uploadTrimSrc(updated, true));
  expect(gridOption().getAttribute("src")).not.toBe(
    uploadTrimSrc(uploaded, true),
  );
  expect(list.mock.calls.length).toBeGreaterThan(listCalls);
  await user.click(screen.getByRole("button", { name: "Deck editor" }));
  expect(
    within(
      screen.getByRole("button", { name: "Choose art for Lightning Bolt" }),
    ).getByRole("img"),
  ).toHaveAttribute("src", uploadTrimSrc(updated, true));
  await user.click(screen.getByRole("button", { name: "Back to decks" }));
  read.mockClear();
  await user.click(await screen.findByRole("button", { name: "Back up Burn" }));
  await waitFor(() => expect(saveText).toHaveBeenCalledOnce());
  expect(read).toHaveBeenCalledWith(id);
  expect(JSON.parse(saveText.mock.calls[0]?.[0].contents)).toEqual(stored);
});

it("shows restored source bleed on the first reopen of a cached deck", async () => {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const uploaded = artSchema.parse({
    ...community,
    id: "upload:1",
    imageUrl: `upload://${id}`,
    source: "My uploads",
    provider: "upload",
    bleedMm: 3.048,
  });
  const withBleed = (bleedMm: number) => ({
    ...deck,
    entries: [{ ...entry, selectedArt: { ...uploaded, bleedMm } }],
  });
  let stored = withBleed(3.048);
  const updated = withBleed(3.175);
  const restored = {
    ...updated,
    id: "221c934a-dc11-4c97-88ff-ff467375a521",
    name: "Restored Burn",
  };
  vi.spyOn(api, "decks").mockImplementation(async () => [stored]);
  vi.spyOn(api, "deck").mockImplementation(async (deckId) =>
    deckId === id ? stored : restored,
  );
  vi.spyOn(api, "restoreDeck").mockImplementation(async () => {
    stored = updated;
    return { deck: restored, updatedUploads: 1 };
  });
  vi.spyOn(api, "art").mockResolvedValue({
    items: [],
    page: 1,
    hasMore: false,
    total: 0,
  });
  vi.spyOn(api, "uploads").mockImplementation(async () =>
    stored.entries.flatMap(({ selectedArt }) =>
      selectedArt ? [selectedArt] : [],
    ),
  );
  vi.spyOn(api, "preferences").mockResolvedValue({
    preferences: {},
    usage: {},
  });
  renderWithClient(<App />, client);
  const openArt = async (bleedMm: number) => {
    const tile = await screen.findByRole("button", {
      name: "Choose art for Lightning Bolt",
    });
    const src = uploadTrimSrc({ ...uploaded, bleedMm }, true);
    expect(within(tile).getByRole("img")).toHaveAttribute("src", src);
    await user.click(tile);
    expect(
      screen.getByRole("img", { name: `${uploaded.name}, ${uploaded.source}` }),
    ).toHaveAttribute("src", src);
    return within(screen.getByRole("region", { name: "Preview art" }));
  };
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  expect((await openArt(3.048)).getByText("3.048 mm")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to decks" }));
  expect(client.getQueryData(["deck", id])).toEqual(stored);

  const contents = JSON.stringify(updated);
  const file = new File([contents], "burn.deckpress.json");
  Object.defineProperty(file, "text", { value: async () => contents });
  await user.upload(
    await screen.findByLabelText("Restore a deck from a JSON backup"),
    file,
  );
  expect(
    await screen.findByRole("heading", { name: "Restored Burn" }),
  ).toBeVisible();
  expect(client.getQueryData(["deck", id])).toEqual(updated);
  expect((await openArt(3.175)).getByText("3.175 mm")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to decks" }));
  await user.click(await screen.findByRole("button", { name: "Open Burn" }));
  const preview = await openArt(3.175);
  expect(preview.getByText("3.175 mm")).toBeVisible();
  expect(preview.queryByText("3.048 mm")).not.toBeInTheDocument();

  stored = withBleed(3.048);
  await act(() => client.refetchQueries({ queryKey: ["deck", id] }));
  expect(await preview.findByText("3.048 mm")).toBeVisible();
  expect(screen.getByRole("status", { name: "Saved" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Deck settings" }));
  const name = screen.getByRole("textbox", { name: "Deck name" });
  await user.type(name, " draft");
  stored = updated;
  await act(() => client.refetchQueries({ queryKey: ["deck", id] }));
  expect(name).toHaveValue("Burn draft");
  expect(screen.getByRole("status", { name: "Unsaved changes" })).toBeVisible();
});

it("replaces the live announcement once for every restore, even with identical text", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "decks").mockResolvedValue([]);
  vi.spyOn(api, "deck").mockResolvedValue(deck);
  const contents = JSON.stringify(deck);
  const restore = vi.fn();
  mockIPC((cmd, args) => {
    if (cmd === "restore_deck") return restore(args);
    return [];
  });
  renderWithClient(<App />);
  const file = new File([contents], "burn.deckpress.json");
  Object.defineProperty(file, "text", { value: async () => contents });
  const status = screen.getByRole("status", { name: "Import announcements" });
  const messages: (string | null)[] = [];
  const observer = new MutationObserver((records) => {
    for (const { addedNodes } of records) {
      for (const node of addedNodes) messages.push(node.textContent);
    }
  });
  observer.observe(status, { childList: true });
  try {
    for (const [updatedUploads, text] of [
      [1, "Deck restored, updated source bleed on 1 upload"],
      [0, "Deck restored"],
      [0, "Deck restored"],
      [2, "Deck restored, updated source bleed on 2 uploads"],
    ] as const) {
      restore.mockReturnValueOnce({ deck, updatedUploads });
      const previous = status.firstChild;
      const count = messages.length;
      await user.upload(
        await screen.findByLabelText("Restore a deck from a JSON backup"),
        file,
      );
      expect(
        await screen.findByRole("heading", { name: "Burn" }),
      ).toBeVisible();
      expect(restore).toHaveBeenLastCalledWith({ contents });
      await waitFor(() => {
        expect(status.textContent).toBe(text);
        expect(status.firstChild).not.toBe(previous);
        expect(messages.slice(count)).toEqual([text]);
      });
      expect(within(screen.getByRole("main")).getByText(text)).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Back to decks" }));
      expect(messages.slice(count)).toEqual([text]);
    }
  } finally {
    observer.disconnect();
  }
});

it("saves an ordered list of print languages and strict policy in app settings", async () => {
  const user = userEvent.setup();
  const save = vi
    .spyOn(api, "savePrintLanguage")
    .mockImplementation(async (value) => value);
  window.location.hash = "#/settings";
  renderWithClient(<App />);
  await user.selectOptions(await screen.findByLabelText("First choice"), "es");
  await user.selectOptions(screen.getByLabelText("Add a language"), "fr");
  await user.selectOptions(
    screen.getByLabelText("If none are available"),
    "strict",
  );
  const button = screen.getByRole("button", { name: "Save print languages" });
  await user.click(button);
  expect(save).toHaveBeenCalledWith({
    languages: ["es", "fr"],
    policy: "strict",
  });
  await waitFor(() => expect(button).toBeDisabled());
});

it("lists skipped cards and badges English fallbacks in the saved deck", async () => {
  const user = userEvent.setup();
  let saved = { ...deck, entries: [] as DeckEntry[] };
  const localized: DeckEntry = {
    ...entry,
    card: { ...entry.card, faces: [{ ...original, language: "es" }] },
    requestedLanguages: ["es"],
  };
  const fallback: DeckEntry = {
    ...entry,
    id: "38314027-5003-49ff-aa3a-825082526106",
    card: {
      ...entry.card,
      id: "ace130da-9914-49b3-a40c-5273bec3813d",
      oracleId: "ace130da-9914-49b3-a40c-5273bec3813d",
      name: "Black Lotus",
      faces: [
        { ...original, set: "lea", collectorNumber: "232", language: "en" },
      ],
    },
    requestedLanguages: ["es"],
  };
  mockIPC((cmd, args) => {
    switch (cmd) {
      case "health":
        return { status: "ok", service: "@deckpress/desktop" };
      case "list_decks":
        return [saved];
      case "get_deck":
        return saved;
      case "resolve_cards":
        return {
          entries: [localized, fallback],
          issues: [
            {
              line: 2,
              input: "1 Time Walk (lea) 84",
              message: "No usable scan found in es.",
              kind: "noUsableScan",
              printLookup: {
                set: "lea",
                collectorNumber: "84",
                languages: ["es"],
              },
            },
          ],
          missingPrints: [{ input: "1 Time Walk (lea) 84", languages: ["es"] }],
        };
      case "save_deck":
        saved = deckSchema.parse((args as { deck: unknown }).deck);
        return saved;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  window.location.hash = `#/decks/${id}`;
  renderWithClient(<App />);
  await user.type(
    await screen.findByLabelText("Decklist"),
    "1 Lightning Bolt{enter}1 Time Walk (LEA) 84",
  );
  await user.click(screen.getByRole("button", { name: "Resolve on Scryfall" }));
  const skipped = within(
    await screen.findByRole("list", { name: "Unresolved lines" }),
  );
  expect(skipped.getByText("1 Time Walk (lea) 84")).toBeVisible();
  expect(skipped.getByText("No usable Spanish scan.")).toBeVisible();
  expect(skipped.getByText("Looked up: LEA #84 (es)")).toBeVisible();
  expect(screen.getByText("Line 2")).toBeVisible();
  const languageSummary =
    "No usable scan for 1 printing. 4 cards use English fallback.";
  const announcement = screen.getByText(new RegExp(languageSummary));
  expect(announcement.closest('[role="status"]')).toHaveAttribute(
    "aria-atomic",
    "true",
  );
  expect(
    within(screen.getByRole("list", { name: "English fallbacks" })).getByText(
      "Black Lotus — LEA #232 (es → en)",
    ),
  ).toBeVisible();
  await user.click(
    await screen.findByRole("button", { name: "Add 8 cards to deck" }),
  );
  expect(
    await screen.findByText("Not imported (last import): 1 Time Walk (lea) 84"),
  ).toBeVisible();
  expect(
    within(
      screen.getByRole("region", { name: "Missing in Spanish" }),
    ).getByText("English fallback: Black Lotus"),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Choose art for Black Lotus" }),
  ).toHaveAccessibleDescription("English fallback");
  expect(
    within(
      screen.getByRole("button", { name: "Choose art for Black Lotus" }),
    ).getByText("English fallback"),
  ).toBeVisible();
  expect(
    within(
      screen.getByRole("button", { name: "Choose art for Lightning Bolt" }),
    ).getByText("ES"),
  ).toBeVisible();
});

it("distinguishes an unknown name from a name-only printing without a usable scan", async () => {
  const user = userEvent.setup();
  const emptyDeck = { ...deck, entries: [] };
  mockIPC((cmd) => {
    switch (cmd) {
      case "health":
        return { status: "ok", service: "@deckpress/desktop" };
      case "list_decks":
        return [emptyDeck];
      case "get_deck":
        return emptyDeck;
      case "resolve_cards":
        return {
          entries: [],
          issues: [
            {
              line: 1,
              input: "1 Black Lotus",
              kind: "noUsableScan",
              message: "No usable scan found in es, la.",
              printLookup: {
                set: "lea",
                collectorNumber: "232",
                languages: ["es", "la"],
              },
            },
            {
              line: 2,
              input: "1 Not A Card",
              kind: "notFound",
              message:
                "Exact card or printing not found. Correct the name/set rather than silently choosing another printing.",
            },
          ],
          missingPrints: [{ input: "1 Black Lotus", languages: ["es", "la"] }],
        };
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  window.location.hash = `#/decks/${id}`;
  renderWithClient(<App />);
  await user.type(
    await screen.findByLabelText("Decklist"),
    "# Main{enter}1 Black Lotus{enter}1 Not A Card",
  );
  await user.click(screen.getByRole("button", { name: "Resolve on Scryfall" }));
  const skipped = within(
    await screen.findByRole("list", { name: "Unresolved lines" }),
  );
  const [knownRow, unknownRow] = skipped.getAllByRole("listitem");
  if (!knownRow || !unknownRow) throw new Error("Expected both skipped rows");
  const known = within(knownRow);
  const unknown = within(unknownRow);
  expect(known.getByText("Line 2")).toBeVisible();
  expect(known.getByText("1 Black Lotus")).toBeVisible();
  expect(known.getByText("Looked up: LEA #232 (es / la)")).toBeVisible();
  expect(known.getByText("No usable scan in Spanish / Latin.")).toBeVisible();
  expect(unknown.getByText("Line 3")).toBeVisible();
  expect(unknown.getByText("1 Not A Card")).toBeVisible();
  expect(unknown.getByText(/Exact card or printing not found\./)).toBeVisible();
  expect(unknown.queryByText(/Looked up:|No usable/)).not.toBeInTheDocument();
});

it("identifies which of two printings of the same card fell back before save", () => {
  const localized = {
    ...entry,
    requestedLanguages: ["es"],
    card: { ...entry.card, faces: [{ ...original, language: "es" }] },
  };
  const fallback = {
    ...localized,
    id: "38314027-5003-49ff-aa3a-825082526106",
    card: {
      ...entry.card,
      id: "ace130da-9914-49b3-a40c-5273bec3813d",
      faces: [
        { ...original, set: "m11", collectorNumber: "149", language: "en" },
      ],
    },
  };
  renderWithClient(
    <ImportReview
      result={{ entries: [localized, fallback], issues: [], format: "Arena" }}
      existing={0}
      replace={false}
      onReplace={vi.fn()}
      showLines
      saving={false}
      saved={null}
      saveError={null}
      onSave={vi.fn()}
    />,
  );
  const fallbacks = within(
    screen.getByRole("list", { name: "English fallbacks" }),
  );
  expect(fallbacks.getByRole("listitem")).toHaveTextContent(
    "Lightning Bolt — M11 #149 (es → en)",
  );
});

it("filters art by language and sends the selected language to Scryfall", async () => {
  const user = userEvent.setup();
  const english = { ...original, language: "en" };
  const spanish = { ...alternate, language: "es" };
  const search = vi.spyOn(api, "art").mockImplementation(async (provider) => ({
    items: provider === "scryfall" ? [english, spanish] : [],
    page: 1,
    hasMore: false,
    total: 2,
  }));
  vi.spyOn(api, "uploads").mockResolvedValue([]);
  vi.spyOn(api, "preferences").mockResolvedValue({
    preferences: {},
    usage: {},
  });
  renderWithClient(
    <ArtPicker
      deck={deck}
      entry={entry}
      onSelect={vi.fn()}
      onApply={vi.fn()}
    />,
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Language" }),
    "es",
  );
  const option = await screen.findByRole("button", {
    name: "Select Mystical Archive 42 by Anato Finnstark",
  });
  expect(within(option).getByText("ES")).toBeVisible();
  expect(
    screen.queryByRole("button", {
      name: "Select Magic 2010 146 by Christopher Moeller",
    }),
  ).toBeNull();
  expect(search).toHaveBeenCalledWith(
    "scryfall",
    id,
    "Lightning Bolt",
    0,
    1,
    expect.any(AbortSignal),
    "es",
  );
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

it("keys candidate collection on the chosen printing and includes it", async () => {
  vi.spyOn(api, "art").mockResolvedValue({
    items: [original],
    page: 1,
    hasMore: false,
    total: 1,
  });
  const swapped: DeckEntry = { ...entry, selectedArt: community };
  const policy: DeckEntry = { ...entry, policyArt: [alternate] };
  expect(optionsKey(swapped)).not.toEqual(optionsKey(entry));
  expect(optionsKey(policy)).not.toEqual(optionsKey(entry));
  expect(optionsKey({ ...entry, id: "other-entry" })).toEqual(
    optionsKey(entry),
  );
  expect((await collectOptions(entry)).map((art) => art.id)).toEqual([
    original.id,
  ]);
  expect((await collectOptions(swapped)).map((art) => art.id)).toEqual([
    original.id,
    community.id,
  ]);
  expect((await collectOptions(policy)).map((art) => art.id)).toEqual([
    original.id,
    alternate.id,
  ]);
});

it("returns to the start with the error when collecting printings fails", async () => {
  const user = userEvent.setup();
  const other: DeckEntry = {
    ...entry,
    id: "b4f5c8d1-0903-40be-8f8c-e9dcb5aa7241",
    card: {
      ...entry.card,
      id: "b4f5c8d1-0903-40be-8f8c-e9dcb5aa7241",
      oracleId: "b4f5c8d1-0903-40be-8f8c-e9dcb5aa7241",
      name: "Fireblast",
    },
  };
  const art = vi
    .spyOn(api, "art")
    .mockRejectedValueOnce(new Error("Scryfall is unreachable"))
    .mockResolvedValue({
      items: [alternate],
      page: 1,
      hasMore: false,
      total: 1,
    });
  const match = vi.spyOn(api, "matchArtStyle").mockResolvedValue({
    method: "heuristic",
    model: null,
    warnings: [],
    embedded: 0,
    skipped: 0,
    matches: [{ entryId: other.id, ranked: [] }],
  });
  renderWithClient(
    <StyleMatch
      deck={{ ...deck, entries: [entry, other] }}
      entry={entry}
      reference={original}
      onClose={vi.fn()}
      onApply={vi.fn(async (value: Deck) => value)}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Find matches" }));
  expect(await screen.findByText(/Scryfall is unreachable/)).toBeVisible();
  expect(
    screen.getByRole("status", { name: "Art style match status" }),
  ).toBeEmptyDOMElement();
  expect(match).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(match).toHaveBeenCalledOnce());
  expect(art).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Scryfall is unreachable/)).toBeNull();
});

it("announces style-match phases and the result once, not every count", async () => {
  const user = userEvent.setup();
  const others = ["Fireblast", "Lava Spike"].map((name, index): DeckEntry => {
    const cardId = `b4f5c8d1-0903-40be-8f8c-e9dcb5aa724${index}`;
    return {
      ...entry,
      id: cardId,
      card: { ...entry.card, id: cardId, oracleId: cardId, name },
    };
  });
  const firstPage = Promise.withResolvers<void>();
  vi.spyOn(api, "art").mockImplementation(async (_provider, oracleId) => {
    if (oracleId === others[1]?.card.oracleId) await firstPage.promise;
    return { items: [alternate], page: 1, hasMore: false, total: 1 };
  });
  const report = Promise.withResolvers<StyleReport>();
  let progress: ((value: { done: number; total: number }) => void) | undefined;
  vi.spyOn(api, "matchArtStyle").mockImplementation((_request, onProgress) => {
    progress = onProgress;
    return report.promise;
  });
  renderWithClient(
    <StyleMatch
      deck={{ ...deck, entries: [entry, ...others] }}
      entry={entry}
      reference={original}
      onClose={vi.fn()}
      onApply={vi.fn(async (value: Deck) => value)}
    />,
  );
  const status = screen.getByRole("status", { name: "Art style match status" });
  const announced: string[] = [];
  const observer = new MutationObserver(() => {
    const text = status.textContent ?? "";
    if (text && announced.at(-1) !== text) announced.push(text);
  });
  observer.observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  await user.click(screen.getByRole("button", { name: "Find matches" }));
  expect(await screen.findByText("1 / 2")).toBeVisible();
  await waitFor(() =>
    expect(status).toHaveTextContent(/^Collecting printings…$/),
  );
  expect(screen.getByText("1 / 2").closest("[role=status]")).toBeNull();
  firstPage.resolve();
  expect(await screen.findByText("Comparing illustrations")).toBeVisible();
  await waitFor(() =>
    expect(status).toHaveTextContent(/^Comparing illustrations…$/),
  );
  act(() => progress?.({ done: 1, total: 2 }));
  expect(screen.getByText("1 / 2")).toBeVisible();
  act(() => progress?.({ done: 2, total: 2 }));
  expect(screen.getByText("2 / 2")).toBeVisible();
  expect(status).toHaveTextContent(/^Comparing illustrations…$/);
  expect(
    screen.getByRole("progressbar", { name: "Art style match progress" }),
  ).toHaveValue(2);
  report.resolve({
    method: "heuristic",
    model: null,
    warnings: [],
    embedded: 0,
    skipped: 0,
    matches: others.map((other) => ({ entryId: other.id, ranked: [] })),
  });
  expect(await screen.findByText("No changes selected")).toBeVisible();
  await waitFor(() =>
    expect(status).toHaveTextContent(/^Matches ready for 2 cards\.$/),
  );
  observer.disconnect();
  expect(announced).toEqual([
    "Collecting printings…",
    "Comparing illustrations…",
    "Matches ready for 2 cards.",
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

it("labels only English fallback scans on each Print Preview page", async () => {
  const user = userEvent.setup();
  const fallback = {
    ...entry,
    quantity: 1,
    requestedLanguages: ["es"],
    card: {
      ...entry.card,
      faces: [{ ...original, language: "en" }],
    },
  };
  const localized = {
    ...fallback,
    id: "38314027-5003-49ff-aa3a-825082526106",
    card: {
      ...entry.card,
      name: "Sol Ring",
      faces: [{ ...original, language: "es" }],
    },
  };
  const otherFallback = {
    ...fallback,
    id: "38314027-5003-49ff-aa3a-825082526107",
    card: { ...fallback.card, name: "Black Lotus" },
  };
  renderWithClient(
    <PrintSetup
      deck={{
        ...deck,
        entries: [fallback, localized, otherFallback],
        printSettings: printSettingsSchema.parse({
          calibrationPage: true,
          columns: 1,
          rows: 1,
        }),
      }}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onJobs={vi.fn()}
      mpcExport={{ busy: false, run: () => {} }}
    />,
  );
  const next = screen.getByRole("button", { name: "Next page" });
  expect(screen.getByRole("img", { name: "Calibration page" })).toBeVisible();
  expect(screen.queryByText("English fallback")).not.toBeInTheDocument();
  await user.click(next);
  const sheet = screen.getByRole("img", { name: /Print preview/ });
  expect(within(sheet).getByText("English fallback")).toBeVisible();
  expect(
    within(sheet)
      .getByText("English fallback")
      .parentElement?.querySelectorAll("rect[stroke]"),
  ).toHaveLength(2);
  expect(sheet).toHaveAccessibleDescription("English fallback: Lightning Bolt");
  await user.click(next);
  expect(within(sheet).queryByText("English fallback")).not.toBeInTheDocument();
  expect(sheet).not.toHaveAccessibleDescription();
  await user.click(next);
  expect(within(sheet).getByText("English fallback")).toBeVisible();
  expect(sheet).toHaveAccessibleDescription("English fallback: Black Lotus");
  expect(next).toBeDisabled();
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
    calibrationPage: true,
    format: "pdf",
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
        mpcExport={{ busy: false, run: () => {} }}
      />
    );
  }
  renderWithClient(<PrintHarness />);
  expect(screen.getByRole("alert")).toHaveTextContent("Cards do not fit");
  for (const button of screen.getAllByRole("button", { name: "Generate PDF" }))
    expect(button).toBeDisabled();
  const columnsLink = screen.getByRole("link", { name: "Adjust columns" });
  columnsLink.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("spinbutton", { name: /^Columns/ })).toHaveFocus();
  await user.selectOptions(screen.getByLabelText("Print preset"), "proof");
  const presetStatus = screen.getByRole("status", {
    name: "Print preset save status",
  });
  expect(presetStatus).toBeEmptyDOMElement();
  const savePreset = screen.getByRole("button", { name: "Save preset" });
  await user.click(savePreset);
  expect(presetStatus).toHaveTextContent("Preset saved on this browser");
  const firstSave = presetStatus.firstChild;
  await user.click(savePreset);
  expect(presetStatus).toHaveTextContent("Preset saved on this browser");
  expect(presetStatus.firstChild).not.toBe(firstSave);
  await user.click(screen.getByRole("button", { name: "Next page" }));
  const proof = screen.getByRole("img", {
    name: /Print preview, A4, 3 columns by 3 rows/,
  });
  expect(proof).toBeVisible();
  const loading = within(proof).getAllByText("Preparing preview…")[0];
  expect(loading).toHaveAttribute(
    "fill",
    "var(--invariant-preview-loading-text)",
  );
  expect(loading?.previousElementSibling).toHaveAttribute(
    "fill",
    "var(--invariant-proof-paper)",
  );
  const image = proof.querySelector("image");
  expect(image).not.toBeNull();
  if (image) fireEvent.error(image);
  const error = within(proof).getByText("Image failed to load");
  expect(error).toHaveAttribute("fill", "var(--invariant-preview-error-text)");
  expect(error.previousElementSibling).toHaveAttribute(
    "fill",
    "var(--invariant-preview-error-bg)",
  );
  await user.click(
    screen.getAllByRole("button", { name: "Generate PDF" })[0] as HTMLElement,
  );
  await waitFor(() => expect(jobs).toHaveBeenCalledOnce());
  expect(jobs).toHaveBeenCalledWith(
    expect.objectContaining({ status: "queued" }),
  );
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      printSettings: expect.objectContaining({ dpi: 300, columns: 0 }),
    }),
  );
  expect(createJob).toHaveBeenCalledWith(
    id,
    expect.objectContaining({ dpi: 300, columns: 0 }),
    "pdf",
  );
  await user.click(screen.getByRole("button", { name: "Other exports" }));
  await user.click(screen.getByRole("menuitem", { name: "PNG ZIP" }));
  await waitFor(() => expect(jobs).toHaveBeenCalledTimes(2));
  expect(createJob).toHaveBeenLastCalledWith(
    id,
    expect.objectContaining({ dpi: 300, columns: 0 }),
    "png",
  );
});

it("keeps Print check outside the sticky proof's scroll range", () => {
  renderWithClient(
    <PrintSetup
      deck={deck}
      onChange={() => {}}
      onSave={async (value) => value}
      onJobs={() => {}}
      mpcExport={{ busy: false, run: () => {} }}
    />,
  );
  const check = screen.getByRole("heading", { name: "Print check" });
  const proof = document.querySelector(".proof-sticky");
  expect(proof?.parentElement).toHaveClass("proof-area");
  expect(proof?.parentElement).not.toContainElement(check);
});

it("saves a cut template from the Other exports menu and explains it in SCM mode", async () => {
  const user = userEvent.setup();
  const saveDialog = vi
    .fn()
    .mockReturnValueOnce(null)
    .mockReturnValueOnce("/chosen/burn.svg");
  const saveTemplate = vi.fn();
  mockIPC((cmd, args) => {
    if (cmd === "export_file_name") return exportFileName(args);
    if (cmd === "plugin:dialog|save") return saveDialog(args);
    if (cmd === "save_cut_template") return saveTemplate(args);
  });
  function PrintHarness() {
    const [value, setValue] = useState(deck);
    return (
      <PrintSetup
        deck={value}
        onChange={setValue}
        onSave={async (value) => value}
        onJobs={() => {}}
        mpcExport={{ busy: false, run: () => {} }}
      />
    );
  }
  renderWithClient(<PrintHarness />);
  const menuButton = screen.getByRole("button", { name: "Other exports" });
  menuButton.focus();
  await user.keyboard("{Enter}{End}{Enter}");
  expect(menuButton).toHaveFocus();
  expect(saveDialog).toHaveBeenCalledWith({
    options: expect.objectContaining({
      defaultPath: "Burn-cut-template.svg",
      filters: [{ name: "SVG cut template", extensions: ["svg"] }],
    }),
  });
  expect(saveTemplate).not.toHaveBeenCalled();
  const status = screen.getByRole("status", {
    name: "Cut template export status",
  });
  expect(status).toBeEmptyDOMElement();
  await user.click(menuButton);
  await user.click(screen.getByRole("menuitem", { name: "SVG cut template" }));
  await waitFor(() =>
    expect(saveTemplate).toHaveBeenCalledWith({
      destination: "/chosen/burn.svg",
      settings: deck.printSettings,
    }),
  );
  expect(status).toHaveTextContent(
    /^Cut template saved to \/chosen\/burn\.svg$/,
  );
  expect(status).toBeVisible();
  const mode = screen.getByRole("combobox", { name: "Layout mode" });
  await user.selectOptions(mode, "scm");
  const template = screen.getByRole("combobox", {
    name: "Silhouette Cameo template",
  });
  await user.selectOptions(template, "a4:borderless");
  expect(template).toHaveValue("a4:borderless");
  await user.click(menuButton);
  const svg = screen.getByRole("menuitem", { name: "SVG cut template" });
  expect(svg).toHaveAttribute("aria-disabled", "true");
  expect(svg).toHaveAccessibleDescription(
    "SCM layouts use the .studio3 cut template.",
  );
  await user.click(svg);
  expect(saveDialog).toHaveBeenCalledTimes(2);
  expect(svg).toBeVisible();
  await user.keyboard("{Escape}");
  expect(menuButton).toHaveFocus();
  await user.selectOptions(mode, "free");
  await user.click(menuButton);
  expect(
    screen.getByRole("menuitem", { name: "SVG cut template" }),
  ).not.toHaveAttribute("aria-disabled");
});

it("mounts the print preset status before saving", async () => {
  const user = userEvent.setup();
  const store = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {});
  renderWithClient(
    <PrintSetup
      deck={deck}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onJobs={vi.fn()}
      mpcExport={{ busy: false, run: () => {} }}
    />,
  );
  const status = screen.getByRole("status", {
    name: "Print preset save status",
  });
  expect(status).toBeEmptyDOMElement();
  await user.click(screen.getByRole("button", { name: "Save preset" }));
  expect(store).toHaveBeenCalledWith(
    "deckpress.print-preset",
    JSON.stringify(deck.printSettings),
  );
  expect(status).toHaveTextContent(/^Preset saved on this browser$/);
  const firstMessage = status.firstElementChild;
  expect(firstMessage).toHaveTextContent("Preset saved on this browser");
  await user.click(screen.getByRole("button", { name: "Save preset" }));
  expect(status.firstElementChild).toHaveTextContent(
    "Preset saved on this browser",
  );
  expect(status.firstElementChild).not.toBe(firstMessage);
});

it("loading an older preset does not retain the previous selection's profile id", async () => {
  const user = userEvent.setup();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) =>
    key === "deckpress.print-preset" ? '{"backOffsetXmm":2}' : null,
  );
  const change = vi.fn();
  renderWithClient(
    <PrintSetup
      deck={{
        ...deck,
        printSettings: { ...deck.printSettings, printerProfileId: id },
      }}
      onChange={change}
      onSave={vi.fn()}
      onJobs={vi.fn()}
      mpcExport={{ busy: false, run: () => {} }}
    />,
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Print preset" }),
    "saved",
  );
  const loaded = change.mock.lastCall?.[0].printSettings;
  expect(loaded.backOffsetXmm).toBe(2);
  expect(loaded.printerProfileId).toBeUndefined();
});

it.each([
  [1, "Main deck + companion · All sheets"],
  [2, "Main deck + companions · All sheets"],
])("prints %i companion card(s) by default", (quantity, label) => {
  renderWithClient(
    <PrintSetup
      deck={{
        ...deck,
        entries: [
          ...deck.entries,
          {
            ...entry,
            id: "6f1e2c55-3d7a-4c9e-9a51-2b8f0d4e7c13",
            quantity,
            zone: "companion",
          },
        ],
      }}
      onChange={() => {}}
      onSave={async (value) => value}
      onJobs={() => {}}
      mpcExport={{ busy: false, run: () => {} }}
    />,
  );
  const summary = within(screen.getByRole("region", { name: "Print summary" }));
  expect(summary.getByText(label)).toBeVisible();
});

it("shows the selected trim and warns when bleed exceeds half the gap", async () => {
  const user = userEvent.setup();
  function PrintHarness() {
    const [value, setValue] = useState(deck);
    return (
      <PrintSetup
        deck={value}
        onChange={setValue}
        onSave={async (value) => value}
        onJobs={() => {}}
        mpcExport={{ busy: false, run: () => {} }}
      />
    );
  }
  renderWithClient(<PrintHarness />);
  const summary = within(screen.getByRole("region", { name: "Print summary" }));
  expect(summary.getByText("A4 · portrait")).toBeVisible();
  expect(summary.getByText("63 × 88 mm")).toBeVisible();
  expect(summary.getByText("1 mm per side · Mirror")).toBeVisible();
  expect(summary.getByText("800 DPI")).toBeVisible();
  expect(summary.getByText("Fronts only")).toBeVisible();
  expect(summary.getByText("Main deck · All sheets")).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Generate PDF" })).toHaveLength(
    1,
  );
  summary.getByRole("button", { name: "Generate PDF" }).focus();
  await user.tab();
  expect(summary.getByRole("button", { name: "Other exports" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Next page" })).toHaveFocus();
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  expect(summary.getByRole("button", { name: "Generate PDF" })).toHaveFocus();
  expect(summary.queryAllByRole("button", { name: /PNG|SVG|MPC/ })).toEqual([]);
  expect(document.querySelectorAll("button.primary")).toHaveLength(1);
  const cardSize = screen.getByLabelText("Card size");
  await user.selectOptions(
    cardSize,
    screen.getByRole("option", {
      name: "Poker / MPC 63.5 × 88.9 mm (larger than MTG)",
    }),
  );
  expect(summary.getByText("63.5 × 88.9 mm")).toBeVisible();
  expect(screen.getByText(/Bleed exceeds half the gap/)).toBeVisible();
  const gap = screen.getByRole("spinbutton", { name: /Gap between bleeds/ });
  await user.clear(gap);
  await user.type(gap, "2");
  expect(screen.queryByText(/Bleed exceeds half the gap/)).toBeNull();
});

it.each([
  {
    name: "a range beyond the deck",
    entries: [entry],
    settings: { pageFrom: 3 },
    message: "No sheets in the selected range",
    action: "Adjust first sheet",
    role: "spinbutton",
    control: /^First sheet/,
  },
  {
    name: "a filtered board",
    entries: [{ ...entry, zone: "side" as const }],
    settings: {},
    message: "No printable cards",
    action: "Review card inclusion",
    role: "checkbox",
    control: "Include sideboard",
  },
  {
    name: "an excluded card",
    entries: [{ ...entry, excluded: true }],
    settings: {},
    message: "No printable cards",
    action: "Include Lightning Bolt",
    role: "checkbox",
    control: "Print Lightning Bolt",
  },
  {
    name: "an unavailable selected model",
    entries: [entry],
    settings: { upscale: true, upscaleModel: "not-installed" },
    message: "The selected upscaler is unavailable",
    action: "Choose an upscaler",
    role: "combobox",
    control: "Model",
  },
  {
    name: "an invalid advanced value",
    entries: [entry],
    settings: { dpi: 50 },
    message: "Too small",
    action: "Go to invalid setting",
    role: "spinbutton",
    control: /^Custom resolution/,
  },
])("links the export blocker to the control for $name", async (fixture) => {
  const user = userEvent.setup();
  function PrintHarness() {
    const [value, setValue] = useState<Deck>({
      ...deck,
      entries: fixture.entries,
      printSettings: { ...deck.printSettings, ...fixture.settings },
    });
    return (
      <PrintSetup
        deck={value}
        onChange={setValue}
        onSave={async (next) => next}
        onJobs={() => {}}
        mpcExport={{ busy: false, run: () => {} }}
      />
    );
  }
  renderWithClient(<PrintHarness />);
  const blockers = screen.getByRole("region", { name: "Export blockers" });
  const action = await within(blockers).findByRole("link", {
    name: fixture.action,
  });
  expect(blockers).toHaveTextContent(fixture.message);
  const exportButton = screen.getByRole("button", { name: "Generate PDF" });
  expect(exportButton).toBeDisabled();
  action.focus();
  await user.keyboard("{Enter}");
  const control = screen.getByRole(fixture.role, { name: fixture.control });
  expect(control).toHaveFocus();
  expect(control).toHaveClass("blocker-focus");
  if (fixture.action === "Include Lightning Bolt") {
    await user.keyboard(" ");
    expect(exportButton).toBeEnabled();
    expect(
      screen.getByRole("heading", { name: "Include & page range" }),
    ).toHaveFocus();
  }
});

it.each(["width", "height"] as const)(
  "reveals invalid saved Custom paper %s without navigating or changing paper",
  async (dimension) => {
    const user = userEvent.setup();
    const changes = vi.fn();
    function PrintHarness() {
      const [value, setValue] = useState(deck);
      return (
        <PrintSetup
          deck={value}
          onChange={(next) => {
            changes(next);
            setValue(next);
          }}
          onSave={async (next) => next}
          onJobs={() => {}}
          mpcExport={{ busy: false, run: () => {} }}
        />
      );
    }
    renderWithClient(<PrintHarness />);
    const paper = screen.getByRole("combobox", { name: "Paper size" });
    const label = new RegExp(`^Sheet ${dimension}`);
    await user.selectOptions(paper, "custom");
    const input = screen.getByRole("spinbutton", { name: label });
    await user.clear(input);
    await user.type(input, "20");
    await user.selectOptions(paper, "a4");
    expect(screen.queryByRole("spinbutton", { name: label })).toBeNull();
    const href = window.location.href;
    const before = changes.mock.calls.length;
    await user.click(
      screen.getByRole("link", { name: "Go to invalid setting" }),
    );
    expect(screen.getByRole("spinbutton", { name: label })).toHaveFocus();
    expect(screen.getByRole("spinbutton", { name: label })).toHaveClass(
      "blocker-focus",
    );
    expect(paper).toHaveValue("a4");
    expect(window.location.href).toBe(href);
    expect(changes).toHaveBeenCalledTimes(before);
  },
);

it.each([
  { patch: { guides: "none", guideWidthPt: 0 }, target: /^Line thickness/ },
  { patch: { guides: "none", guideColor: "invalid" }, target: /^Guide color/ },
  { patch: { guides: "full", guideLengthMm: 0 }, target: /^Mark length/ },
  { patch: { guides: "full", guideOffsetMm: -1 }, target: /^Mark offset/ },
  {
    patch: { bleedMode: "mirror", bleedColor: "invalid" },
    target: /^Solid colour/,
  },
] as const)(
  "reveals a conditional advanced control: $target",
  async ({ patch, target }) => {
    const user = userEvent.setup();
    const change = vi.fn();
    renderWithClient(
      <PrintSetup
        deck={{ ...deck, printSettings: { ...deck.printSettings, ...patch } }}
        onChange={change}
        onSave={async (value) => value}
        onJobs={() => {}}
        mpcExport={{ busy: false, run: () => {} }}
      />,
    );
    await user.click(
      screen.getByRole("link", { name: "Go to invalid setting" }),
    );
    const control = screen.getByLabelText(target);
    expect(control).toBeVisible();
    expect(control).toHaveFocus();
    expect(control.closest("details")).toHaveAttribute("open");
    expect(change).not.toHaveBeenCalled();
  },
);

it("moves pointer-activated blocker focus to Print and clears its ring on blur", async () => {
  const user = userEvent.setup();
  renderWithClient(
    <PrintSetup
      deck={{ ...deck, entries: [{ ...entry, excluded: true }] }}
      onChange={vi.fn()}
      onSave={async (next) => next}
      onJobs={() => {}}
      mpcExport={{ busy: false, run: () => {} }}
    />,
  );
  await user.click(
    screen.getByRole("link", { name: "Include Lightning Bolt" }),
  );
  const checkbox = screen.getByRole("checkbox", {
    name: "Print Lightning Bolt",
  });
  expect(checkbox).toHaveFocus();
  expect(checkbox).toHaveClass("blocker-focus");
  await user.tab();
  expect(checkbox).not.toHaveClass("blocker-focus");
});

it.each(printPageCounts)(
  "shows the PDF page count for $name",
  async (fixture) => {
    const user = userEvent.setup();
    const { quantity, settings, cardSheets, pdfPages, calibrationPages } =
      fixture;
    renderWithClient(
      <PrintSetup
        deck={{
          ...deck,
          entries: quantity ? [{ ...entry, quantity }] : [],
          printSettings: printSettingsSchema.parse(settings),
        }}
        onChange={() => {}}
        onSave={async (value) => value}
        onJobs={() => {}}
        mpcExport={{ busy: false, run: () => {} }}
      />,
    );
    const summary = screen.getByRole("region", { name: "Print summary" });
    const sheets = `${cardSheets} card ${cardSheets === 1 ? "sheet" : "sheets"}`;
    const pages = `${pdfPages} PDF ${pdfPages === 1 ? "page" : "pages"}`;
    expect(summary).toHaveTextContent(`${sheets} · ${pages}`);
    if (calibrationPages) {
      expect(summary).toHaveTextContent(
        `(includes ${calibrationPages} calibration ${calibrationPages === 1 ? "page" : "pages"})`,
      );
    } else {
      expect(summary).not.toHaveTextContent(/calibration/);
    }
    for (const button of screen.getAllByRole("button", {
      name: "Generate PDF",
    })) {
      if (cardSheets) expect(button).toBeEnabled();
      else expect(button).toBeDisabled();
    }
    const next = screen.getByRole("button", { name: "Next page" });
    const previous = screen.getByRole("button", { name: "Previous page" });
    expect(previous).toBeDisabled();
    if (pdfPages === 0) {
      expect(screen.queryByText("Sheet 8 of 7")).not.toBeInTheDocument();
      expect(screen.getByText("Page 0 of 0")).toBeVisible();
      expect(next).toBeDisabled();
      return;
    }
    for (let page = 1; page <= pdfPages; page++) {
      const counter = screen.getByText(`Page ${page} of ${pdfPages}`, {
        exact: false,
      });
      if (page <= calibrationPages) {
        const label =
          page === 1 ? "Calibration page" : "Blank calibration back";
        expect(counter).toHaveTextContent(label);
        const proof = screen.getByRole("img", { name: label });
        expect(proof).toBeVisible();
        if (page === 1 && "rulerMm" in fixture) {
          expect(proof).toHaveTextContent(`${fixture.rulerMm} mm ruler`);
          expect(proof).not.toHaveTextContent("MTG reference");
        }
      } else {
        expect(counter).toHaveTextContent(/Sheet \d+ · (front|back)/);
      }
      if (page < pdfPages) {
        expect(next).toBeEnabled();
        await user.click(next);
      }
    }
    expect(next).toBeDisabled();
    if (pdfPages > 1) {
      await user.click(previous);
      expect(
        screen.getByText(`Page ${pdfPages - 1} of ${pdfPages}`, {
          exact: false,
        }),
      ).toBeVisible();
    }
  },
);

it("clamps SCM bleed visibly and previews the selected registration template", async () => {
  const user = userEvent.setup();
  function PrintHarness() {
    const [value, setValue] = useState<Deck>({
      ...deck,
      printSettings: {
        ...deck.printSettings,
        bleedMm: 1.4,
        backs: "short-edge",
        calibrationPage: false,
      },
    });
    return (
      <PrintSetup
        deck={value}
        onChange={setValue}
        onSave={async () => value}
        onJobs={() => {}}
        mpcExport={{ busy: false, run: () => {} }}
      />
    );
  }
  renderWithClient(<PrintHarness />);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Layout mode" }),
    "scm",
  );
  const bleed = screen.getByRole("spinbutton", { name: /^Bleed per side/ });
  expect(bleed).toHaveValue(0.625);
  const backs = screen.getByRole("combobox", { name: "Back pages" });
  expect(backs).toHaveValue("long-edge");
  const summary = within(screen.getByRole("region", { name: "Print summary" }));
  expect(summary.getByText("A4 · Standard layout")).toBeVisible();
  expect(summary.getByText(/mm · locked by template/)).toBeVisible();
  expect(summary.getByText("0.625 mm per side · Mirror")).toBeVisible();
  expect(summary.getByText("Duplex · flip long edge")).toBeVisible();
  expect(
    screen.queryByRole("spinbutton", { name: /^Card width/ }),
  ).not.toBeInTheDocument();
  const mode = screen.getByRole("combobox", { name: "Layout mode" });
  await user.selectOptions(mode, "free");
  expect(bleed).toHaveValue(1.4);
  expect(backs).toHaveValue("short-edge");
  await user.selectOptions(mode, "scm");
  await user.clear(bleed);
  await user.type(bleed, "2");
  expect(bleed).toHaveValue(0.625);
  expect(screen.getByText(/SCM limits bleed to 0.625 mm/)).toHaveAttribute(
    "role",
    "status",
  );
  expect(
    screen.queryByRole("combobox", { name: "Style" }),
  ).not.toBeInTheDocument();
  await user.selectOptions(
    screen.getByRole("combobox", { name: "SCM registration marks" }),
    "4",
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Silhouette Cameo template" }),
    "arch_b:default",
  );
  const preview = screen.getByRole("img", {
    name: /Print preview, arch_b-standard-v/,
  });
  expect(
    preview.querySelectorAll('rect[fill="var(--invariant-proof-ink)"]'),
  ).toHaveLength(8);
  expect(preview).toHaveTextContent("template: arch_b-standard-v");
});

it("filters the paper-grouped cutter picker by card size and keeps free geometry", async () => {
  const user = userEvent.setup();
  function PrintHarness() {
    const [value, setValue] = useState<Deck>({
      ...deck,
      printSettings: {
        ...deck.printSettings,
        paper: "letter",
        orientation: "portrait",
        cardWidthMm: 59,
        gapMm: 2,
        columns: 2,
        rows: 2,
        calibrationPage: false,
      },
    });
    return (
      <PrintSetup
        deck={value}
        onChange={setValue}
        onSave={async () => value}
        onJobs={() => {}}
        mpcExport={{ busy: false, run: () => {} }}
      />
    );
  }
  renderWithClient(<PrintHarness />);
  const mode = screen.getByRole("combobox", { name: "Layout mode" });
  const freePreview = "Print preview, US Letter, 2 columns by 2 rows";
  expect(screen.getByRole("img", { name: freePreview })).toBeVisible();
  await user.selectOptions(mode, "scm");

  const card = screen.getByRole("combobox", { name: "Template card size" });
  const picker = screen.getByRole("combobox", {
    name: "Silhouette Cameo template",
  });
  const marks = screen.getByRole("combobox", {
    name: "SCM registration marks",
  });
  const cuttingTemplates = screen.getByRole("link", {
    name: "SCM cutting templates",
  });
  mode.focus();
  for (const control of [card, picker, marks, cuttingTemplates]) {
    await user.tab();
    expect(control).toHaveFocus();
  }
  expect(cuttingTemplates).toHaveAttribute(
    "href",
    expect.stringMatching(
      /^https:\/\/github\.com\/Alan-Cha\/silhouette-card-maker\/tree\/[a-f0-9]+\/cutting_templates$/,
    ),
  );

  const a4 = within(picker).getByRole("group", { name: "A4" });
  expect(within(a4).getAllByRole("option")).toHaveLength(2);
  expect(
    within(picker).getByRole("group", { name: "US Letter" }),
  ).toBeVisible();
  expect(screen.getByText("a4-standard-v5.studio3")).toBeVisible();
  expect(screen.getByText("4 × 2 · 8 cards per sheet")).toBeVisible();
  const threeMarks = screen.getByRole("img", {
    name: "Print preview, a4-standard-v5, 4 columns by 2 rows",
  });
  expect(
    threeMarks.querySelectorAll('rect[fill="var(--invariant-proof-ink)"]'),
  ).toHaveLength(5);
  expect(screen.queryByRole("spinbutton", { name: /Card width/ })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Orientation" })).toBeNull();
  expect(screen.getByText("A4 · landscape")).toBeVisible();

  await user.selectOptions(card, "poker");
  expect(card).toHaveDisplayValue("Poker · 2.5in × 3.5in");
  expect(screen.getByText("a4-poker-v3.studio3")).toBeVisible();
  expect(screen.queryByText("a4-standard-v5.studio3")).not.toBeInTheDocument();
  await user.selectOptions(card, "standard");
  await user.selectOptions(
    picker,
    within(a4).getByRole("option", { name: "A4 · Borderless layout" }),
  );
  expect(screen.getByText("a4-standard-borderless-v2.studio3")).toBeVisible();
  expect(screen.getByText("3 × 3 · 9 cards per sheet")).toBeVisible();
  expect(
    screen.getByRole("img", {
      name: "Print preview, a4-standard-borderless-v2, 3 columns by 3 rows",
    }),
  ).toBeVisible();

  await user.selectOptions(picker, "arch_b:borderless");
  expect(screen.getAllByText(/No SCM cut file for this layout/)).toHaveLength(
    1,
  );
  expect(screen.queryByText(/\.studio3$/)).not.toBeInTheDocument();
  expect(screen.queryByText("Cut file")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "SCM borderless docs" }),
  ).toHaveAttribute(
    "href",
    expect.stringMatching(/\/hugo\/content\/miscellaneous\/borderless\.md$/),
  );
  await user.selectOptions(mode, "free");
  expect(screen.getByRole("img", { name: freePreview })).toBeVisible();
  expect(
    screen.getByRole("spinbutton", { name: /Gap between bleeds/ }),
  ).toHaveValue(2);
  expect(screen.getByRole("spinbutton", { name: /Card width/ })).toHaveValue(
    59,
  );
  expect(
    screen.queryByRole("link", { name: "SCM cutting templates" }),
  ).toBeNull();
});

it("exposes the active library format and keeps filters available with the sidebar closed", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "decks").mockResolvedValue([deck]);
  mockIPC(() => ({ status: "ok", service: "@deckpress/desktop" }));
  renderWithClient(<App />);

  const all = await screen.findByRole("button", {
    name: /^All/,
    pressed: true,
  });
  const modern = await screen.findByRole("button", {
    name: /^Modern/,
    pressed: false,
  });
  await user.click(modern);
  expect(all).toHaveAttribute("aria-pressed", "false");
  expect(modern).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(screen.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  expect(
    screen.queryByRole("navigation", { name: "Main navigation" }),
  ).toBeNull();
  expect(
    screen.getByRole("searchbox", { name: "Search decks, formats, cards" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: /^Modern/, pressed: true }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Show sidebar" }));
  expect(
    screen.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
});

it("keeps a failed library request visible and lets the user retry", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "decks")
    .mockRejectedValueOnce(new Error("Local storage unavailable"))
    .mockResolvedValue([]);
  mockIPC(() => ({ status: "ok", service: "@deckpress/desktop" }));
  renderWithClient(<App />);
  const error = await within(screen.getByRole("main")).findByRole("alert");
  expect(error).toHaveTextContent("Local storage unavailable");
  await user.click(within(error).getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: "Start an empty deck" }),
  ).toBeVisible();
});
