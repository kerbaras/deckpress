import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { uploadTrimSrc } from "./api.ts";
import {
  artSchema,
  backArt,
  deckSchema,
  entrySchema,
  frontArt,
} from "./core/index.ts";
import { entryLanguageLabel, isEnglishFallback } from "./print-language.tsx";
import { ToolbarSlotProvider } from "./titlebar.tsx";
import { Workspace } from "./workspace.tsx";

async function openPolicy() {
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
    requestedLanguages: ["es"],
  });
  const upload = artSchema.parse({
    ...before,
    id: "upload:art",
    provider: "upload",
    imageUrl: "upload://art",
    thumbnailUrl: "upload://art",
    bleedMm: 2,
  });
  const pinned = {
    ...entry,
    id: crypto.randomUUID(),
    artPinned: true,
    selectedArt: upload,
  };
  const unmatched = { ...entry, id: crypto.randomUUID() };
  const deck = deckSchema.parse({
    id: crypto.randomUUID(),
    name: "Art policy demo",
    format: "Casual",
    entries: [entry, pinned, unmatched],
    revision: 0,
    printSettings: { calibrationPage: false },
    createdAt: "2026-11-26T12:00:00Z",
    updatedAt: "2026-11-26T12:00:00Z",
  });
  const previewId = crypto.randomUUID();
  const result = {
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
        before: upload,
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
  };
  const preview = vi.fn<() => typeof result | Promise<typeof result>>(
    () => result,
  );
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
      case "settings":
        return {
          models: [],
          defaultModel: "",
          loaded: null,
          storage: "Local SQLite",
          localOnly: true,
          dataDir: ".",
        };
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
          printSetup={undefined}
          focusHeading={false}
          onBack={vi.fn()}
          onDirty={vi.fn()}
          onPreviewChange={vi.fn()}
          registerPolicyPreview={vi.fn()}
          confirmArtExit={() => true}
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
  return {
    user,
    settings,
    trigger,
    open,
    preview,
    result,
    apply,
    undo,
    deck,
    entry,
    after,
    previewId,
    upload,
  };
}

it("uses the trimmed upload thumbnail in a protected art preview row", async () => {
  const { open, upload } = await openPolicy();
  const dialog = await open();
  const row = (await dialog.findByText("Pinned — unchanged")).closest("li");
  expect(row?.querySelector("img")).toHaveAttribute(
    "src",
    uploadTrimSrc(upload, true),
  );
});

it("previews protected and unresolved art; Keep and Escape write nothing; Apply can be undone", async () => {
  const { user, settings, trigger, open, apply, undo, deck, previewId } =
    await openPolicy();
  let dialog = await open();
  expect(await dialog.findByText("Pinned — unchanged")).toBeVisible();
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
  await dialog.findByText("Pinned — unchanged");
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
  const newTrigger = settings.getByRole("button", {
    name: "Preview art policy",
  });
  expect(newTrigger).not.toBe(trigger);
  expect(newTrigger).toHaveFocus();
  await user.click(settings.getByRole("button", { name: "Close dialog" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Group cards" }),
    "art",
  );
  expect(screen.getByText("Chosen art")).toBeVisible();
  const group = screen.getByRole("button", {
    name: "Choose art for Lightning Bolt",
    description: "English fallback",
  });
  expect(within(group).getByText("English fallback")).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Missing in Spanish" }),
  ).toHaveTextContent("English fallback: Lightning Bolt");
  await user.click(screen.getByRole("button", { name: "Print setup" }));
  const sheet = await screen.findByRole("img", { name: /Print preview/ });
  expect(within(sheet).getByText("English fallback")).toBeVisible();
  expect(sheet).toHaveAccessibleDescription("English fallback: Lightning Bolt");
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
  expect(
    screen.getByRole("img", { name: /Print preview/ }),
  ).not.toHaveAccessibleDescription();
  await user.click(reopened.getByRole("button", { name: "Close dialog" }));
  await user.click(screen.getByRole("button", { name: "Deck editor" }));
  expect(
    screen.queryByRole("region", { name: "Missing in Spanish" }),
  ).not.toBeInTheDocument();
  for (const card of screen.getAllByRole("button", {
    name: "Choose art for Lightning Bolt",
  }))
    expect(card).toHaveAccessibleDescription("ES");
});

it.each(["Keep", "Apply"])(
  "ignores a deferred preview result arriving after %s",
  async (choice) => {
    const { user, settings, trigger, open, preview, result, apply } =
      await openPolicy();
    const late = Promise.withResolvers<typeof result>();
    preview.mockReturnValueOnce(late.promise);
    const pending = await open();
    expect(
      pending.getByRole("status", { name: "Art preview status" }),
    ).toHaveTextContent("Finding matching printings");
    expect(
      pending.getByRole("button", { name: "Apply art changes" }),
    ).toBeDisabled();
    await user.click(
      pending.getByRole("button", { name: "Keep current choices" }),
    );
    expect(trigger).toHaveFocus();

    if (choice === "Apply") {
      const current = await open();
      await current.findByText("Pinned — unchanged");
      await user.click(
        current.getByRole("button", { name: "Apply art changes" }),
      );
      expect(apply).toHaveBeenCalledOnce();
    }
    const status = settings.getByRole("status", { name: "Art policy status" });
    const announcement = choice === "Apply" ? "Art changes applied." : "";
    expect(status.textContent).toBe(announcement);
    await act(async () =>
      late.resolve({ ...result, previewId: crypto.randomUUID() }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Preview art changes" }),
    ).not.toBeInTheDocument();
    expect(status.textContent).toBe(announcement);
    expect(apply).toHaveBeenCalledTimes(choice === "Apply" ? 1 : 0);
    expect(
      settings.getByRole("button", { name: "Preview art policy" }),
    ).toHaveFocus();
  },
);

it("distinguishes fallback provenance from manual English art, including the back face", async () => {
  const { entry, after } = await openPolicy();
  const back = { ...after, id: "scryfall:back" };
  const policy = { ...entry, policyArt: [after, back] };
  expect(isEnglishFallback(policy)).toBe(true);
  expect(isEnglishFallback(policy, backArt(policy) ?? frontArt(policy))).toBe(
    true,
  );
  expect(
    isEnglishFallback({
      ...policy,
      selectedArt: { ...after, id: "scryfall:manual" },
    }),
  ).toBe(false);
  expect(isEnglishFallback({ ...policy, selectedArt: after })).toBe(true);
  expect(
    isEnglishFallback({
      ...entry,
      selectedArt: { ...after, englishFallback: true },
    }),
  ).toBe(true);
  expect(
    entryLanguageLabel({
      ...entry,
      selectedArt: { ...after, id: "scryfall:manual" },
      selectedBack: { ...back, englishFallback: true },
    }),
  ).toBe("EN · not preferred / English fallback back");
});
