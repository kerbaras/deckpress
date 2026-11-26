import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { artSchema, deckSchema, entrySchema } from "./core/index.ts";
import { ToolbarSlotProvider } from "./titlebar.tsx";
import { Workspace } from "./workspace.tsx";

it("previews protected and unresolved art; Keep and Escape write nothing; Apply can be undone", async () => {
  const user = userEvent.setup();
  const before = artSchema.parse({
    id: "scryfall:current",
    provider: "scryfall",
    name: "Lightning Bolt",
    set: "m11",
    collectorNumber: "149",
    language: "es",
    source: "Magic 2011",
    imageUrl: "https://cards.scryfall.io/current.jpg",
    thumbnailUrl: "https://cards.scryfall.io/current.jpg",
  });
  const after = {
    ...before,
    id: "scryfall:original",
    set: "lea",
    collectorNumber: "161",
    language: "en",
  };
  const entry = entrySchema.parse({
    id: crypto.randomUUID(),
    card: {
      id: crypto.randomUUID(),
      oracleId: crypto.randomUUID(),
      name: "Lightning Bolt",
      typeLine: "Instant",
      manaCost: "{R}",
      manaValue: 1,
      colors: ["R"],
      faces: [before],
    },
    zone: "main",
    quantity: 1,
  });
  const pinned = { ...entry, id: crypto.randomUUID(), artPinned: true };
  const unmatched = { ...entry, id: crypto.randomUUID() };
  const deck = deckSchema.parse({
    id: crypto.randomUUID(),
    name: "Art policy demo",
    format: "Casual",
    entries: [entry, pinned, unmatched],
    revision: 0,
    printSettings: {},
    createdAt: "2026-11-26T12:00:00Z",
    updatedAt: "2026-11-26T12:00:00Z",
  });
  const previewId = crypto.randomUUID();
  const preview = vi.fn(() => ({
    previewId,
    canApply: true,
    changes: [
      {
        entryId: entry.id,
        name: "Lightning Bolt",
        quantity: 1,
        before,
        after,
        kind: "fallback",
        reason: "Same illustration; using the English scan.",
      },
      {
        entryId: pinned.id,
        name: "Manual print",
        quantity: 1,
        before,
        after: null,
        kind: "pinned",
        reason: "Manual art is protected.",
      },
      {
        entryId: unmatched.id,
        name: "Missing print",
        quantity: 1,
        before,
        after: null,
        kind: "unmatched",
        reason: "No usable same-illustration scan.",
      },
    ],
  }));
  const apply = vi.fn(() => ({
    ...deck,
    revision: 1,
    artPolicy: { kind: "original" },
    entries: [{ ...entry, policyArt: [after] }, pinned, unmatched],
  }));
  const undo = vi.fn(() => ({ ...deck, revision: 2 }));
  mockIPC((cmd, args) => {
    switch (cmd) {
      case "get_deck":
        return deck;
      case "preview_art_policy":
        return Reflect.apply(preview, undefined, [args]);
      case "apply_art_preview":
        return Reflect.apply(apply, undefined, [args]);
      case "undo_art_change":
        return Reflect.apply(undo, undefined, [args]);
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const slot = document.createElement("div");
  document.body.append(slot);
  render(
    <QueryClientProvider client={client}>
      <ToolbarSlotProvider value={slot}>
        <Workspace
          id={deck.id}
          focusHeading={false}
          onBack={vi.fn()}
          onDirty={vi.fn()}
          onJobs={vi.fn()}
        />
      </ToolbarSlotProvider>
    </QueryClientProvider>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Deck settings" }),
  );
  const settings = within(
    screen.getByRole("dialog", { name: "Deck settings" }),
  );
  const trigger = settings.getByRole("button", { name: "Preview art policy" });
  const open = async () => {
    await user.click(trigger);
    return within(
      await screen.findByRole("dialog", { name: "Preview art changes" }),
    );
  };
  let dialog = await open();
  expect(dialog.getByText("Pinned — unchanged")).toBeVisible();
  expect(dialog.getByText("Unmatched — unchanged")).toBeVisible();
  expect(dialog.getByText("English fallback")).toBeVisible();
  expect(dialog.getByText("LEA #161 · EN")).toBeVisible();
  await user.click(
    dialog.getByRole("button", { name: "Keep current choices" }),
  );
  expect(trigger).toHaveFocus();
  dialog = await open();
  fireEvent(
    dialog
      .getByRole("button", { name: "Close dialog" })
      .closest("dialog") as HTMLDialogElement,
    new Event("cancel", { cancelable: true }),
  );
  expect(
    screen.queryByRole("dialog", { name: "Preview art changes" }),
  ).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(apply).not.toHaveBeenCalled();
  dialog = await open();
  await user.click(dialog.getByRole("button", { name: "Apply art changes" }));
  expect(apply).toHaveBeenCalledOnce();
  expect(apply).toHaveBeenCalledWith({
    deckId: deck.id,
    expectedRevision: 0,
    previewId,
  });
  expect(
    await settings.findByRole("status", { name: "Art policy status" }),
  ).toHaveTextContent("Art changes applied.");
  await user.click(settings.getByRole("button", { name: "Close dialog" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Group cards" }),
    "art",
  );
  expect(screen.getByText("Chosen art")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Deck settings" }));
  const reopened = within(
    screen.getByRole("dialog", { name: "Deck settings" }),
  );
  await user.click(
    reopened.getByRole("button", { name: "Undo last art change" }),
  );
  expect(undo).toHaveBeenCalledWith({ deckId: deck.id, expectedRevision: 1 });
  expect(
    reopened.getByRole("status", { name: "Art policy status" }),
  ).toHaveTextContent("Art changes undone.");
});
