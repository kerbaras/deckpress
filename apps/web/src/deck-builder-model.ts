import type { BuilderFormat, BuilderSpec, BuilderTheme } from "./api.ts";
import { type Card, type Deck, type DeckEntry, formats } from "./core/index.ts";

/** Wizard steps in order; Commander decks pick a commander instead of colours. */
export const stepIds = [
  "format",
  "commander",
  "colors",
  "style",
  "cards",
] as const;
export type StepId = (typeof stepIds)[number];

export const stepNames: Record<StepId, string> = {
  format: "Format",
  commander: "Commander",
  colors: "Colours",
  style: "Style & theme",
  cards: "Cards",
};

export interface WizardState {
  format: BuilderFormat | null;
  set: string;
  colors: string[];
  commander: Card | null;
  style: string;
  theme: string;
  tribe: string;
}

export const emptyState: WizardState = {
  format: null,
  set: "",
  colors: [],
  commander: null,
  style: "",
  theme: "",
  tribe: "",
};

export function stepsFor(format: BuilderFormat | null): StepId[] {
  if (format?.commander) return ["format", "commander", "style", "cards"];
  return ["format", "colors", "style", "cards"];
}

/** Why the user cannot leave `step` yet, or null when they can. */
export function blocker(
  state: WizardState,
  step: StepId,
  themes: BuilderTheme[],
): string | null {
  switch (step) {
    case "format":
      if (!state.format) return "Choose a format to continue";
      if (state.format.needsSet && !state.set)
        return "Pick the set you drafted";
      return null;
    case "commander":
      return state.commander ? null : "Search for and pick a commander";
    case "colors":
      return state.format?.needsSet && state.colors.length === 0
        ? "Pick the colours you drafted"
        : null;
    case "style": {
      if (!state.style) return "Pick a play style";
      if (!state.theme) return "Pick a theme";
      const theme = themes.find((item) => item.id === state.theme);
      if (theme?.needsTribe && !state.tribe.trim())
        return "Type the creature type your deck is built around";
      return null;
    }
    case "cards":
      return null;
  }
}

export function toSpec(state: WizardState): BuilderSpec | null {
  if (!state.format) return null;
  return {
    format: state.format.id,
    set: state.set,
    colors: state.commander ? state.commander.colors : state.colors,
    commander: state.commander,
    style: state.style,
    theme: state.theme,
    tribe: state.tribe.trim(),
  };
}

/**
 * Drops picked cards that no longer fit the wizard settings: everything when
 * the format changes, cards from another set for Draft/Limited, and cards
 * outside the colour identity when colours (or the commander) change.
 */
export function fitEntries(
  entries: DeckEntry[],
  previous: WizardState,
  next: WizardState,
): DeckEntry[] {
  if (next.format?.id !== previous.format?.id) return [];
  const spec = toSpec(next);
  if (!spec) return [];
  const set = next.format?.needsSet ? spec.set.toLowerCase() : "";
  const colors = spec.colors;
  return entries.filter((entry) => {
    if (entry.zone === "commander") return entry.card.id === spec.commander?.id;
    const printed = entry.card.faces[0]?.set.toLowerCase() ?? "";
    if (set && printed !== set && !isBasic(entry.card)) return false;
    return entry.card.colors.every((color) => colors.includes(color));
  });
}

/** The `Deck.format` label for a builder format; unknown labels fall back to Casual. */
export const deckFormatOf = (format: BuilderFormat): Deck["format"] =>
  formats.find((label) => label === format.deckFormat) ?? "Casual";

export const isLand = (card: Card) => /\bLand\b/.test(card.typeLine);
export const isBasic = (card: Card) => /\bBasic\b/.test(card.typeLine);

export const copiesOf = (entries: DeckEntry[], card: Card) =>
  entries
    .filter((entry) => entry.card.oracleId === card.oracleId)
    .reduce((sum, entry) => sum + entry.quantity, 0);

/** Basic lands ignore copy limits in every format. */
export const copyLimit = (card: Card, maxCopies: number) =>
  isBasic(card) ? 250 : maxCopies;

const newId = () => crypto.randomUUID();

/**
 * Adds one copy of `card` to the main deck, merging with an existing entry.
 * Returns the same array when the copy limit is already reached.
 */
export function addCard(
  entries: DeckEntry[],
  card: Card,
  maxCopies: number,
): DeckEntry[] {
  if (copiesOf(entries, card) >= copyLimit(card, maxCopies)) return entries;
  const index = entries.findIndex(
    (entry) => entry.card.oracleId === card.oracleId && entry.zone === "main",
  );
  if (index >= 0) {
    return entries.map((entry, at) =>
      at === index ? { ...entry, quantity: entry.quantity + 1 } : entry,
    );
  }
  return [
    ...entries,
    {
      id: newId(),
      card,
      quantity: 1,
      zone: "main",
      selectedArt: null,
      selectedBack: null,
      excluded: false,
    },
  ];
}

/** Sets an entry's quantity within the copy limit; zero removes it. */
export function setQuantity(
  entries: DeckEntry[],
  id: string,
  quantity: number,
  maxCopies: number,
): DeckEntry[] {
  const entry = entries.find((item) => item.id === id);
  if (!entry) return entries;
  const others = copiesOf(entries, entry.card) - entry.quantity;
  const room = Math.max(0, copyLimit(entry.card, maxCopies) - others);
  const next = Math.min(Math.max(0, Math.floor(quantity)), room);
  if (next === 0) return entries.filter((item) => item.id !== id);
  return entries.map((item) =>
    item.id === id ? { ...item, quantity: next } : item,
  );
}

/** Appends entries from "Fill remaining slots", merging duplicates by card. */
export function mergeEntries(
  entries: DeckEntry[],
  added: DeckEntry[],
): DeckEntry[] {
  const merged = entries.slice();
  for (const entry of added) {
    const index = merged.findIndex(
      (item) =>
        item.card.oracleId === entry.card.oracleId && item.zone === "main",
    );
    if (index >= 0) {
      const existing = merged[index];
      if (existing)
        merged[index] = {
          ...existing,
          quantity: existing.quantity + entry.quantity,
        };
    } else merged.push({ ...entry, zone: "main" });
  }
  return merged;
}

export const removeCard = (entries: DeckEntry[], id: string) =>
  entries.filter((entry) => entry.id !== id);

export function commanderEntry(card: Card): DeckEntry {
  return {
    id: newId(),
    card,
    quantity: 1,
    zone: "commander",
    selectedArt: null,
    selectedBack: null,
    excluded: false,
  };
}

/** Sorts the deck for display: commander, then spells by mana value, lands last. */
export function orderEntries(entries: DeckEntry[]): DeckEntry[] {
  return entries.slice().sort((a, b) => {
    const rank = (entry: DeckEntry) =>
      entry.zone === "commander" ? 0 : isLand(entry.card) ? 2 : 1;
    return (
      rank(a) - rank(b) ||
      a.card.manaValue - b.card.manaValue ||
      a.card.name.localeCompare(b.card.name)
    );
  });
}

export function defaultDeckName(
  state: WizardState,
  styleName: string,
  themeName: string,
): string {
  if (state.commander) {
    const short = state.commander.name.split(",")[0]?.trim() ?? "Commander";
    return `${short} ${themeName.toLowerCase()}`.trim();
  }
  const theme =
    state.theme === "typal" && state.tribe ? state.tribe : themeName;
  return [state.format?.name ?? "", styleName, theme]
    .filter(Boolean)
    .join(" ")
    .replace(" / Limited", "")
    .trim();
}

export const scorePercent = (score: number) =>
  `${Math.round(Math.min(1, Math.max(0, score)) * 100)}`;

/** Display names for the roles `deckpress-core` assigns, in display order. */
export const roleNames: Record<string, string> = {
  commander: "Commander",
  ramp: "Ramp",
  draw: "Card draw",
  removal: "Removal",
  interaction: "Interaction",
  tutor: "Tutor",
  threat: "Threat",
  wincon: "Finisher",
  synergy: "Synergy",
  land: "Land",
  utility: "Utility",
};

export const roleName = (role: string) =>
  roleNames[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
