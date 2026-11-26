import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { BuilderFormat, BuilderSpec } from "./api.ts";
import { artSchema, type Card, type DeckEntry } from "./core/index.ts";
import { DeckBuilder } from "./deck-builder.tsx";
import { ToolbarSlotProvider } from "./titlebar.tsx";

const format = (patch: Partial<BuilderFormat>): BuilderFormat => ({
  id: "modern",
  name: "Modern",
  deckFormat: "Modern",
  deckSize: 60,
  landTarget: 24,
  singleton: false,
  maxCopies: 4,
  commander: false,
  needsSet: false,
  description: "Cards from the modern era.",
  ...patch,
});
const options = {
  formats: [
    format({}),
    format({
      id: "pioneer",
      name: "Pioneer",
      deckFormat: "Pioneer",
      description: "Cards from Return to Ravnica on.",
    }),
  ],
  colors: [
    { id: "R", name: "Red", basic: "Mountain" },
    { id: "G", name: "Green", basic: "Forest" },
  ],
  styles: [
    {
      id: "aggro",
      name: "Aggro",
      description: "Fast.",
      landAdjust: 0,
      curve: [],
    },
  ],
  themes: [
    {
      id: "burn",
      name: "Burn",
      description: "Damage.",
      needsTribe: false,
      cues: [],
      typeCues: [],
    },
  ],
  source: "test",
};
const bolt: Card = {
  id: "0b1e2c3d-4f50-4a6b-8c7d-9e0f1a2b3c4d",
  oracleId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
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
};

function summary(spec: BuilderSpec, entries: DeckEntry[]) {
  const count = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  return {
    count,
    target: spec.format === "modern" || spec.format === "pioneer" ? 60 : 40,
    lands: 0,
    landTarget: 24,
    singleton: false,
    maxCopies: 4,
    curve: [],
    colors: [],
    issues: [],
    complete: false,
  };
}

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
  mockIPC((cmd, args) => {
    const payload = args as { spec: BuilderSpec; entries: DeckEntry[] };
    switch (cmd) {
      case "builder_options":
        return options;
      case "builder_suggest":
        return {
          items: [
            {
              card: bolt,
              score: 0.9,
              reasons: ["Burn"],
              role: "removal",
              oracleText: "",
              popularityRank: null,
              metaDecks: 0,
            },
          ],
          page: 1,
          hasMore: false,
          total: 1,
          queries: [],
          colors: payload.spec.colors,
          meta: null,
        };
      case "builder_summary":
        return summary(payload.spec, payload.entries);
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
});

function renderBuilder() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const slot = document.createElement("div");
  document.body.append(slot);
  render(
    <QueryClientProvider client={client}>
      <ToolbarSlotProvider value={slot}>
        <DeckBuilder
          onBack={() => {}}
          onCreated={() => {}}
          onDirty={() => {}}
        />
      </ToolbarSlotProvider>
    </QueryClientProvider>,
  );
}

const step = (name: string) =>
  within(screen.getByRole("list", { name: "Steps" })).getByRole("button", {
    name: new RegExp(name),
  });
/** Forward navigation runs through Next, which is how the wizard re-enters Cards. */
async function nextTo(user: ReturnType<typeof userEvent.setup>, name: string) {
  while (!screen.queryByText(new RegExp(`· ${name}$`))) {
    await user.click(screen.getByRole("button", { name: /Next/ }));
  }
}
const deckList = () =>
  screen.queryByRole("list", { name: "Cards in the deck" });

/** Modern, red, Aggro / Burn, then two Lightning Bolts on the Cards step. */
async function buildRedDraft(user: ReturnType<typeof userEvent.setup>) {
  renderBuilder();
  await user.click(await screen.findByRole("button", { name: /^Modern/ }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  await user.click(screen.getByRole("button", { name: /Red/ }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  await user.click(screen.getByRole("button", { name: /^Aggro/ }));
  await user.click(screen.getByRole("button", { name: /^Burn/ }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  const add = await screen.findByRole("button", { name: "Add Lightning Bolt" });
  await user.click(add);
  await user.click(add);
  expect(deckList()).toHaveTextContent("2×Lightning Bolt");
}

it("asks before a colour change drops a picked card and keeps or applies it", async () => {
  const user = userEvent.setup();
  await buildRedDraft(user);

  await user.click(step("Colours"));
  await user.click(screen.getByRole("button", { name: /Green/ }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: /Green/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await user.click(screen.getByRole("button", { name: /Red/ }));
  const dialog = screen.getByRole("dialog", { name: "Remove picked cards?" });
  expect(
    within(dialog).getByText(/outside the new colour identity/),
  ).toBeVisible();
  expect(within(dialog).getByRole("listitem")).toHaveTextContent(
    "2×Lightning Bolt",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Keep current choices" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: /Red/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await nextTo(user, "Cards");
  expect(deckList()).toHaveTextContent("2×Lightning Bolt");

  await user.click(step("Colours"));
  await user.click(screen.getByRole("button", { name: /Red/ }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Apply change",
    }),
  );
  expect(screen.getByRole("button", { name: /Red/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await nextTo(user, "Cards");
  expect(deckList()).toBeNull();
  expect(screen.getByText("Nothing added yet")).toBeVisible();
});

it("asks before a format change clears the picks and keeps the format on cancel", async () => {
  const user = userEvent.setup();
  await buildRedDraft(user);

  await user.click(step("Format"));
  await user.click(screen.getByRole("button", { name: /^Modern/ }));
  expect(screen.queryByRole("dialog")).toBeNull();

  await user.click(screen.getByRole("button", { name: /^Pioneer/ }));
  const dialog = screen.getByRole("dialog", { name: "Remove picked cards?" });
  expect(within(dialog).getByText(/Switching to Pioneer/)).toBeVisible();
  expect(within(dialog).getByRole("listitem")).toHaveTextContent(
    "2×Lightning Bolt",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Close dialog" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: /^Modern/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await nextTo(user, "Cards");
  expect(deckList()).toHaveTextContent("2×Lightning Bolt");

  await user.click(step("Format"));
  await user.click(screen.getByRole("button", { name: /^Pioneer/ }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Apply change",
    }),
  );
  expect(screen.getByRole("button", { name: /^Pioneer/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByRole("button", { name: /Next/ }));
  expect(screen.getByRole("button", { name: /Red/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await nextTo(user, "Cards");
  expect(screen.getByText("Nothing added yet")).toBeVisible();
});
