import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { artSchema, deckSchema } from "./core/index.ts";
import { DeckLanguageControl, DeckLanguagePreview } from "./deck-language.tsx";
import { Workspace } from "./workspace.tsx";

it("previews a deck language, stages an override and applies or undoes the switch", async () => {
  const user = userEvent.setup();
  const before = artSchema.parse({
    id: "scryfall:english",
    provider: "scryfall",
    name: "Arcane Signet",
    source: "Foundations Commander",
    set: "fdc",
    collectorNumber: "1",
    language: "en",
    imageUrl: "https://cards.scryfall.io/en.jpg",
    thumbnailUrl: "https://cards.scryfall.io/en.jpg",
  });
  const after = {
    ...before,
    id: "scryfall:spanish",
    set: "cmr",
    collectorNumber: "305",
    language: "es",
  };
  const alternate = { ...after, id: "scryfall:alt", set: "eoc" };
  const entry = {
    id: crypto.randomUUID(),
    card: {
      id: crypto.randomUUID(),
      oracleId: crypto.randomUUID(),
      name: before.name,
      typeLine: "Artifact",
      manaCost: "{2}",
      manaValue: 2,
      colors: [],
      faces: [before],
    },
    zone: "main",
    quantity: 2,
  };
  const exact = {
    ...entry,
    id: crypto.randomUUID(),
    quantity: 4,
    card: { ...entry.card, name: "Exact card" },
  };
  const deck = deckSchema.parse({
    id: crypto.randomUUID(),
    name: "Deck language fixture",
    format: "Casual",
    entries: [entry, exact],
    revision: 0,
    printSettings: {},
    createdAt: "2026-11-26T12:00:00Z",
    updatedAt: "2026-11-26T12:00:00Z",
  });
  const previewId = crypto.randomUUID();
  const row = {
    entryId: entry.id,
    name: before.name,
    quantity: 2,
    kind: "changed",
    tier: "closest",
    reason: "",
    before,
    after,
  };
  const preview = {
    previewId,
    canApply: true,
    language: "es",
    changes: [
      row,
      {
        ...row,
        entryId: exact.id,
        name: exact.card.name,
        quantity: 4,
        tier: "samePrinting",
      },
    ],
  };
  const ipc = vi.fn((cmd: string, _args: unknown) => {
    switch (cmd) {
      case "get_deck":
        return deck;
      case "preview_deck_language":
        return preview;
      case "search_art":
        return {
          items: [before, alternate],
          page: 1,
          hasMore: false,
          total: 2,
        };
      case "override_language_print":
        return { ...row, tier: "override", after: alternate };
      case "apply_art_preview":
        return { ...deck, revision: 1, printLanguage: "es" };
      case "undo_art_change":
        return { ...deck, revision: 2 };
      default:
        throw new Error(`Unexpected command ${cmd}`);
    }
  });
  mockIPC((cmd, args) => ipc(cmd, args));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Workspace
        id={deck.id}
        printSetup={undefined}
        focusHeading={false}
        onBack={vi.fn()}
        onDirty={vi.fn()}
        onPreviewChange={vi.fn()}
        registerPolicyPreview={vi.fn()}
        confirmArtExit={() => true}
        onJobs={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const control = await screen.findByRole("combobox", {
    name: "Deck language",
  });
  await user.selectOptions(control, "es");
  const dialog = within(
    await screen.findByRole("dialog", {
      name: "Preview deck language · Spanish",
    }),
  );
  const counts = within(
    await dialog.findByRole("list", { name: "Printing match counts" }),
  );
  expect(counts.getByText("Same printing")).toHaveTextContent(
    "4 Same printing",
  );
  expect(counts.getByText("Closest style")).toHaveTextContent(
    "2 Closest style",
  );
  expect(dialog.queryByText("Exact card")).toBeNull();
  expect(dialog.getByText("FDC #1 · EN")).toBeVisible();
  expect(dialog.getByText("CMR #305 · ES")).toBeVisible();
  expect(ipc).toHaveBeenCalledWith("preview_deck_language", {
    deckId: deck.id,
    expectedRevision: 0,
    language: "es",
  });
  await user.click(
    dialog.getByRole("button", { name: "Keep current language" }),
  );
  expect(control).toHaveValue("");
  expect(control).toHaveFocus();
  await user.selectOptions(control, "es");
  await user.click(
    await screen.findByRole("button", {
      name: "Choose another printing for Arcane Signet",
    }),
  );
  const picker = within(
    await screen.findByRole("dialog", {
      name: "Spanish art picker · Arcane Signet",
    }),
  );
  const choose = await picker.findByRole("button", { name: "Use EOC #305" });
  expect(picker.queryByRole("button", { name: "Use FDC #1" })).toBeNull();
  expect(ipc).toHaveBeenCalledWith(
    "search_art",
    expect.objectContaining({ language: "es" }),
  );
  await user.click(choose);
  expect(await screen.findByText("EOC #305 · ES")).toBeVisible();
  expect(control).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Apply Spanish" }));
  await waitFor(() => expect(control).toHaveValue("es"));
  expect(ipc).toHaveBeenCalledWith("apply_art_preview", {
    deckId: deck.id,
    expectedRevision: 0,
    previewId,
  });
  await user.click(
    await screen.findByRole("button", { name: "Undo language change" }),
  );
  await waitFor(() => expect(control).toHaveValue(""));
});

it("explains the web availability of deck language switching", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <DeckLanguageControl
      language={undefined}
      disabled={false}
      web
      onSelect={onSelect}
      onUndo={undefined}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Deck language" }));
  expect(
    screen.getByText(
      "Deck language switching is not available on the web yet.",
    ),
  ).toBeVisible();
  expect(onSelect).not.toHaveBeenCalled();
});

it("keeps the sticky action footer when no printings need review", () => {
  const deck = deckSchema.parse({
    id: crypto.randomUUID(),
    name: "No review rows",
    format: "Casual",
    entries: [],
    revision: 0,
    printSettings: {},
    createdAt: "2026-11-26T12:00:00Z",
    updatedAt: "2026-11-26T12:00:00Z",
  });
  render(
    <DeckLanguagePreview
      deck={deck}
      language="es"
      preview={{ previewId: crypto.randomUUID(), canApply: true, changes: [] }}
      error={undefined}
      busy={false}
      onKeep={vi.fn()}
      onApply={vi.fn()}
      onOverride={vi.fn()}
    />,
  );
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText(/0 rows to review/)).toBeVisible();
  expect(
    dialog.queryByRole("list", { name: "Printings to review" }),
  ).toBeNull();
  const footer = dialog.getByRole("button", {
    name: "Apply Spanish",
  }).parentElement;
  expect(footer?.matches(".modal-panel > .language-preview-actions")).toBe(
    true,
  );
});
