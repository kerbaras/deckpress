import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type BuilderFormat, type BuilderSpec } from "./api.ts";
import {
  artSchema,
  type Card,
  type DeckEntry,
  deckSchema,
} from "./core/index.ts";
import { DeckBuilder } from "./deck-builder.tsx";
import { addCard } from "./deck-builder-model.ts";
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
    format({
      id: "draft",
      name: "Draft",
      deckFormat: "Limited",
      deckSize: 40,
      landTarget: 17,
      needsSet: true,
      description: "Cards from the set you drafted.",
    }),
    format({
      id: "commander",
      name: "Commander",
      deckFormat: "Commander",
      deckSize: 100,
      landTarget: 37,
      singleton: true,
      maxCopies: 1,
      commander: true,
      description: "One legend leads a singleton deck.",
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
      set: "m10",
    }),
  ],
};

let uuid = 0;
const card = (name: string, colors: string[], typeLine = "Creature"): Card => {
  const n = String(++uuid).padStart(12, "0");
  return {
    ...bolt,
    id: `00000000-0000-4000-8000-${n}`,
    oracleId: `00000000-0000-4000-9000-${n}`,
    name,
    typeLine,
    colors,
    faces: bolt.faces.map((face) => ({ ...face, id: `scryfall:${n}`, name })),
  };
};
const radha = card("Radha, Heart of Keld", ["R", "G"], "Legendary Creature");
const goreclaw = card(
  "Goreclaw, Terror of Qal Sisma",
  ["G"],
  "Legendary Creature",
);
const swiftspear = card("Monastery Swiftspear", ["R"]);
const suggestion = (item: Card) => ({
  card: item,
  score: 0.9,
  reasons: ["Burn"],
  role: "removal",
  oracleText: "",
  popularityRank: null,
  metaDecks: 0,
});
/** Resolves the `builder_fill` call the test is holding open. */
let finishFill: (entries: DeckEntry[]) => void = () => {};

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
      this.querySelector("button")?.focus();
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
          items: [suggestion(bolt)],
          page: 1,
          hasMore: false,
          total: 1,
          queries: [],
          colors: payload.spec.colors,
          meta: null,
        };
      case "builder_summary":
        return summary(payload.spec, payload.entries);
      case "builder_sets":
        return [
          {
            code: "m10",
            name: "Magic 2010",
            releasedAt: "2009-07-17",
            cardCount: 249,
          },
          {
            code: "m11",
            name: "Magic 2011",
            releasedAt: "2010-07-16",
            cardCount: 249,
          },
        ];
      case "builder_commanders":
        return [suggestion(radha), suggestion(goreclaw)];
      case "builder_fill":
        return new Promise((resolve) => {
          finishFill = resolve;
        });
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
});

function renderBuilder(onCreated: (id: string) => void = () => {}) {
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
          onCreated={onCreated}
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
async function buildRedDraft(
  user: ReturnType<typeof userEvent.setup>,
  onCreated?: (id: string) => void,
) {
  renderBuilder(onCreated);
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

it.each(["Next", "Back", "Format"])(
  "focuses the destination heading after %s and tabs into the step",
  async (navigation) => {
    const user = userEvent.setup();
    renderBuilder();
    const modern = await screen.findByRole("button", { name: /^Modern/ });
    await user.click(modern);
    await user.click(screen.getByRole("button", { name: "Next" }));
    const forward = navigation === "Next";
    if (!forward) {
      await user.click(
        navigation === "Back"
          ? screen.getByRole("button", { name: "Back" })
          : step("Format"),
      );
    }

    const activeStep = forward ? "Colours" : "Format";
    expect(step(activeStep).closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("heading", {
        name: forward ? "Which colours?" : "What are you building?",
      }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: forward ? /Red/ : /^Modern/ }),
    );
  },
);

it.each(["format", "theme"])(
  "explains the missing %s at Next and prevents keyboard activation",
  async (choice) => {
    const user = userEvent.setup();
    renderBuilder();
    const modern = await screen.findByRole("button", { name: /^Modern/ });
    const next = screen.getByRole("button", { name: "Next" });
    if (choice === "theme") {
      await user.click(modern);
      await user.click(next);
      await user.click(next);
      await user.click(screen.getByRole("button", { name: /^Aggro/ }));
    }
    const blocker =
      choice === "format" ? "Choose a format to continue." : "Pick a theme.";
    const precedingButton =
      choice === "format"
        ? step("Format")
        : screen.getByRole("button", { name: "Back" });
    expect(screen.getByText(blocker)).toBeVisible();
    const status = screen.getByRole("status", { name: "Deck builder blocker" });
    expect(status).toHaveTextContent(blocker);
    const announcement = status.firstChild;
    expect(precedingButton).toBeEnabled();
    precedingButton.focus();
    await user.tab();
    expect(document.activeElement).toBe(next);
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).toHaveAccessibleDescription(blocker);
    await user.keyboard("{Enter} ");
    expect(status.firstChild).toBe(announcement);
    expect(
      step(choice === "format" ? "Format" : "Style & theme").closest("li"),
    ).toHaveAttribute("aria-current", "step");
  },
);

it.each([
  [0, "Deck is full", "The deck is already at its target size"],
  [1, "Fill remaining 1 slot", "Add 1 card: top suggestions, then basic lands"],
  [
    2,
    "Fill remaining 2 slots",
    "Add 2 cards: top suggestions, then basic lands",
  ],
])(
  "labels the fill action when the remaining count is %i",
  async (remaining, label, title) => {
    vi.spyOn(api, "builderSummary").mockImplementation(
      async (spec, entries) => {
        const current = summary(spec, entries);
        return { ...current, target: current.count + remaining };
      },
    );
    await buildRedDraft(userEvent.setup());
    expect(
      screen.getByRole("heading", { name: /Suggestions\s*· 1 card$/ }),
    ).toBeVisible();
    const fill = await screen.findByRole("button", { name: label });
    expect(fill).toHaveAttribute("title", title);
    if (remaining === 0) expect(fill).toBeDisabled();
    else expect(fill).toBeEnabled();
  },
);

it("labels a partial deck as a draft next to Create and creates it", async () => {
  const user = userEvent.setup();
  const onCreated = vi.fn();
  const id = "cf88d760-f679-47df-96fe-bcd1688a0022";
  const createDeck = vi
    .spyOn(api, "createDeck")
    .mockImplementation(async (draft) =>
      deckSchema.parse({
        ...draft,
        id,
        printSettings: {},
        revision: 0,
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
      }),
    );
  await buildRedDraft(user, onCreated);
  const create = screen.getByRole("button", { name: "Create deck" });
  const draft = screen.getByText("Draft · 2 of 60 cards");
  expect(draft).toBeVisible();
  expect(draft.parentElement).toBe(create.parentElement);
  expect(create).toHaveAccessibleDescription("Draft · 2 of 60 cards");
  await user.click(create);
  expect(createDeck).toHaveBeenCalledWith(
    expect.objectContaining({
      entries: [expect.objectContaining({ quantity: 2 })],
    }),
  );
  expect(onCreated).toHaveBeenCalledWith(id);
});

/** Commander with Radha, Aggro / Burn, then one Lightning Bolt on Cards. */
async function buildRadhaDraft(user: ReturnType<typeof userEvent.setup>) {
  renderBuilder();
  await user.click(await screen.findByRole("button", { name: /^Commander/ }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  await user.type(
    screen.getByRole("searchbox", { name: /Search legendary creatures/ }),
    "ra",
  );
  expect(screen.getByText("Search legendary creatures by name")).toBeVisible();
  await user.click(await screen.findByRole("button", { name: /^Radha/ }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  await user.click(screen.getByRole("button", { name: /^Aggro/ }));
  await user.click(screen.getByRole("button", { name: /^Burn/ }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  await user.click(
    await screen.findByRole("button", { name: "Add Lightning Bolt" }),
  );
  expect(deckList()).toHaveTextContent("1×Lightning Bolt");
}

type User = ReturnType<typeof userEvent.setup>;
const pressed = (name: RegExp) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");
const commanderShown = () => screen.getByText(/Commander:/).textContent;
async function cardsAre(user: User, expected: string[]) {
  await nextTo(user, "Cards");
  const rows = deckList()?.querySelectorAll("li") ?? [];
  expect(
    [...rows].map(
      (row) =>
        `${row.querySelector(".mono")?.textContent}${row.querySelector(".builder-deck-title")?.textContent}`,
    ),
  ).toEqual(expected);
}
async function pickCommander(user: User, query: string, name: RegExp) {
  const search = screen.getByRole("searchbox", {
    name: /Search legendary creatures/,
  });
  await user.clear(search);
  await user.type(search, query);
  await user.click(await screen.findByRole("button", { name }));
}
const draftSet = () =>
  (
    screen.getByRole("combobox", {
      name: /Set you drafted/,
    }) as HTMLSelectElement
  ).value;

/** Draft, M10, red, Aggro / Burn, then two Lightning Bolts on the Cards step. */
async function buildDraft(user: User) {
  renderBuilder();
  await user.click(await screen.findByRole("button", { name: /^Draft/ }));
  await user.selectOptions(
    await screen.findByRole("combobox", { name: /Set you drafted/ }),
    "m10",
  );
  await user.click(screen.getByRole("button", { name: /Next/ }));
  await user.click(screen.getByRole("button", { name: /Red/ }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  await user.click(screen.getByRole("button", { name: /^Aggro/ }));
  await user.click(screen.getByRole("button", { name: /^Burn/ }));
  await user.click(screen.getByRole("button", { name: /Next/ }));
  const add = await screen.findByRole("button", { name: "Add Lightning Bolt" });
  await user.click(add);
  await user.click(add);
}

type Scenario = {
  name: string;
  /** Builds a draft and makes the change that opens the confirmation. */
  open: (user: User) => Promise<void>;
  dropped: string[];
  kept: (user: User) => Promise<void>;
  applied: (user: User) => Promise<void>;
};

const redKept = async (user: User) => {
  expect(pressed(/Red/)).toBe("true");
  await cardsAre(user, ["2×Lightning Bolt"]);
};
const redApplied = async (user: User) => {
  expect(pressed(/Red/)).toBe("false");
  await cardsAre(user, []);
};
const radhaKept = async (user: User) => {
  expect(commanderShown()).toBe("Commander: Radha, Heart of Keld");
  expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();
  await cardsAre(user, ["1×Radha, Heart of Keld", "1×Lightning Bolt"]);
};
const goreclawApplied = async (user: User) => {
  expect(commanderShown()).toBe("Commander: Goreclaw, Terror of Qal Sisma");
  await cardsAre(user, ["1×Goreclaw, Terror of Qal Sisma"]);
};

const scenarios: Scenario[] = [
  {
    name: "format change",
    open: async (user) => {
      await buildRedDraft(user);
      await user.click(step("Format"));
      await user.click(screen.getByRole("button", { name: /^Modern/ }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(screen.getByRole("button", { name: /^Pioneer/ }));
    },
    dropped: ["2×Lightning Bolt"],
    kept: async (user) => {
      expect(pressed(/^Modern/)).toBe("true");
      await cardsAre(user, ["2×Lightning Bolt"]);
    },
    applied: async (user) => {
      expect(pressed(/^Pioneer/)).toBe("true");
      await cardsAre(user, []);
    },
  },
  {
    name: "colour change",
    open: async (user) => {
      await buildRedDraft(user);
      await user.click(step("Colours"));
      await user.click(screen.getByRole("button", { name: /Green/ }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(screen.getByRole("button", { name: /Red/ }));
    },
    dropped: ["2×Lightning Bolt"],
    kept: redKept,
    applied: redApplied,
  },
  {
    name: "commander change",
    open: async (user) => {
      await buildRadhaDraft(user);
      await user.click(step("Commander"));
      await user.click(
        await screen.findByRole("button", { name: /^Goreclaw/ }),
      );
    },
    dropped: ["1×Lightning Bolt"],
    kept: radhaKept,
    applied: goreclawApplied,
  },
  {
    name: "commander Change, then another commander",
    open: async (user) => {
      await buildRadhaDraft(user);
      await user.click(step("Commander"));
      await user.click(screen.getByRole("button", { name: "Change" }));
      await pickCommander(user, "go", /^Goreclaw/);
    },
    dropped: ["1×Lightning Bolt"],
    kept: radhaKept,
    applied: goreclawApplied,
  },
  {
    name: "commander Change, re-pick the active format, then another commander",
    open: async (user) => {
      await buildRadhaDraft(user);
      await user.click(step("Commander"));
      await user.click(screen.getByRole("button", { name: "Change" }));
      await user.click(step("Format"));
      await user.click(screen.getByRole("button", { name: /^Commander/ }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(screen.getByRole("button", { name: /Next/ }));
      await pickCommander(user, "go", /^Goreclaw/);
    },
    dropped: ["1×Lightning Bolt"],
    kept: radhaKept,
    applied: goreclawApplied,
  },
  {
    name: "confirmed format change away from a commander, then a colour change",
    open: async (user) => {
      await buildRadhaDraft(user);
      await user.click(step("Format"));
      await user.click(screen.getByRole("button", { name: /^Modern/ }));
      await user.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Apply change",
        }),
      );
      await user.click(screen.getByRole("button", { name: /Next/ }));
      expect(pressed(/Red/)).toBe("true");
      expect(pressed(/Green/)).toBe("true");
      await nextTo(user, "Cards");
      await user.click(
        await screen.findByRole("button", { name: "Add Lightning Bolt" }),
      );
      await user.click(step("Colours"));
      await user.click(screen.getByRole("button", { name: /Red/ }));
    },
    dropped: ["1×Lightning Bolt"],
    kept: async (user) => {
      expect(pressed(/Red/)).toBe("true");
      expect(
        within(screen.getByRole("list", { name: "Steps" })).queryByRole(
          "button",
          { name: /Commander/ },
        ),
      ).toBeNull();
      await cardsAre(user, ["1×Lightning Bolt"]);
    },
    applied: async (user) => {
      expect(pressed(/Red/)).toBe("false");
      expect(pressed(/Green/)).toBe("true");
      await cardsAre(user, []);
    },
  },
  {
    name: "draft set change",
    open: async (user) => {
      await buildDraft(user);
      await user.click(step("Format"));
      await user.selectOptions(
        screen.getByRole("combobox", { name: /Set you drafted/ }),
        "m11",
      );
    },
    dropped: ["2×Lightning Bolt"],
    kept: async (user) => {
      expect(draftSet()).toBe("m10");
      await cardsAre(user, ["2×Lightning Bolt"]);
    },
    applied: async (user) => {
      expect(draftSet()).toBe("m11");
      await cardsAre(user, []);
    },
  },
  {
    name: "colour change while Fill is in flight",
    open: async (user) => {
      await buildRedDraft(user);
      await user.click(
        await screen.findByRole("button", { name: /Fill remaining 58 slots/ }),
      );
      await user.click(step("Colours"));
      await user.click(screen.getByRole("button", { name: /Green/ }));
      await user.click(screen.getByRole("button", { name: /Red/ }));
      await act(async () => finishFill(addCard([], swiftspear, 4)));
    },
    dropped: ["2×Lightning Bolt"],
    kept: redKept,
    applied: redApplied,
  },
];

const closes = {
  keep: (dialog: HTMLElement, user: User) =>
    user.click(
      within(dialog).getByRole("button", { name: "Keep current choices" }),
    ),
  esc: async (dialog: HTMLElement) => {
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
  },
  apply: (dialog: HTMLElement, user: User) =>
    user.click(within(dialog).getByRole("button", { name: "Apply change" })),
};

describe.each(scenarios)("$name", (scenario) => {
  it.each(Object.keys(closes) as (keyof typeof closes)[])(
    "%s",
    async (close) => {
      const user = userEvent.setup();
      await scenario.open(user);
      const dialog = screen.getByRole("dialog", {
        name: "Remove picked cards?",
      });
      expect(
        within(dialog)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(scenario.dropped);
      await closes[close](dialog, user);
      expect(screen.queryByRole("dialog")).toBeNull();
      await (close === "apply" ? scenario.applied : scenario.kept)(user);
    },
  );
});

it("keeps Tab inside the dialog and returns focus to the control that opened it", async () => {
  const user = userEvent.setup();
  await buildRedDraft(user);
  await user.click(step("Colours"));
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Which colours?" }),
  );
  const red = screen.getByRole("button", { name: /Red/ });
  await user.click(red);
  const dialog = screen.getByRole("dialog", { name: "Remove picked cards?" });
  const close = within(dialog).getByRole("button", { name: "Close dialog" });
  const apply = within(dialog).getByRole("button", { name: "Apply change" });
  expect(document.activeElement).toBe(close);

  apply.focus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(apply).toHaveFocus();

  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(red).toHaveFocus();
  expect(red).toHaveAttribute("aria-pressed", "true");

  await user.click(red);
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Keep current choices",
    }),
  );
  expect(red).toHaveFocus();
  expect(document.activeElement).toBe(red);
});
