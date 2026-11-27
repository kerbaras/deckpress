import type { ArtPreview, PrintLanguagePreferences } from "../../api.ts";
import {
  type ArtPolicy,
  backArt,
  type Deck,
  type DeckEntry,
  frontArt,
} from "../../core/index.ts";
import {
  comparePrints,
  localized,
  type Printing,
  permits,
  type policyProvider,
  samePrintingNumber,
} from "../providers/printings.ts";
import { canChangeArt, setFamilyRanks } from "./set-matching.ts";

type ArtChange = ArtPreview["changes"][number];

export function validatePolicy(policy: ArtPolicy) {
  if (policy.kind === "matchSet" && !/^[a-z0-9]{1,20}$/.test(policy.set)) {
    throw new Error("Enter a valid set code.");
  }
  if (
    policy.kind === "style" &&
    policy.frame === null &&
    policy.border === null &&
    policy.treatment === null
  ) {
    throw new Error("Choose a frame, border, or treatment.");
  }
}

function jsonEquals(a: unknown, b: unknown) {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : item,
    );
  return canonical(a) === canonical(b);
}

function languageOrder(preferences: PrintLanguagePreferences) {
  const { languages, policy } = preferences;
  return policy === "fallback-to-english" && !languages.includes("en")
    ? [...languages, "en"]
    : languages;
}

function change(
  entry: DeckEntry,
  kind: ArtChange["kind"],
  after: ArtChange["after"],
  reason: string,
): ArtChange {
  return {
    entryId: entry.id,
    name: entry.card.name,
    quantity: entry.quantity,
    before: frontArt(entry),
    kind,
    after,
    reason,
  };
}

function planChange(
  entry: DeckEntry,
  print: Printing | undefined,
  preferences: PrintLanguagePreferences,
  manual: boolean,
) {
  const scans = print?.scans;
  const first = scans?.[0];
  if (!scans || !first || !print) {
    return {
      entry,
      change: change(
        entry,
        "unmatched",
        null,
        "No usable same-illustration scan matches the requested language and policy.",
      ),
    };
  }
  const fallback =
    print.language === "en" && !preferences.languages.includes("en");
  const next = {
    ...entry,
    requestedLanguages: preferences.languages,
    ...(manual
      ? {
          artPinned: true,
          selectedArt: { ...first, englishFallback: fallback },
          selectedBack: scans[1]
            ? { ...scans[1], englishFallback: fallback }
            : null,
        }
      : { policyArt: scans }),
  };
  const result = fallback
    ? change(
        entry,
        "fallback",
        first,
        manual
          ? "Same illustration; using the English scan."
          : "No preferred-language scan for the policy illustration; using English.",
      )
    : jsonEquals(frontArt(next), frontArt(entry)) &&
        jsonEquals(backArt(next), backArt(entry))
      ? change(
          entry,
          "unchanged",
          first,
          "The displayed printing already matches.",
        )
      : change(entry, "changed", first, "A matching printing is available.");
  return { entry: jsonEquals(entry, next) ? entry : next, change: result };
}

export async function planPolicy(
  provider: ReturnType<typeof policyProvider>,
  deck: Deck,
  policy: ArtPolicy,
  preferences: PrintLanguagePreferences,
  signal?: AbortSignal,
) {
  const request = signal ? ([{ signal }] as const) : ([] as const);
  const oracleIds = deck.entries
    .filter(canChangeArt)
    .map(({ card }) => card.oracleId);
  const ranks =
    policy.kind === "matchSet" && policy.family && oracleIds.length
      ? await setFamilyRanks(policy.set, await provider.sets(...request))
      : undefined;
  const setFilter =
    policy.kind === "matchSet"
      ? ranks
        ? [...ranks.keys()]
        : [policy.set]
      : undefined;
  const batchMemo = new Map<string, Promise<Map<string, Printing[]>>>();
  const memo = new Map<string, Promise<Printing[]>>();
  async function inventory(oracleId: string, lang?: string) {
    if (setFilter) {
      const key = lang ?? "";
      const cached =
        batchMemo.get(key) ??
        provider.inventoryBatch(oracleIds, lang, setFilter, ...request);
      batchMemo.set(key, cached);
      return (await cached).get(oracleId) ?? [];
    }
    const key = `${oracleId}:${lang ?? ""}`;
    const cached =
      memo.get(key) ?? provider.inventory(oracleId, lang, ...request);
    memo.set(key, cached);
    return cached;
  }
  const changes: ArtChange[] = [];
  const entries: DeckEntry[] = [];
  for (const entry of deck.entries) {
    signal?.throwIfAborted();
    if (!canChangeArt(entry)) {
      changes.push(change(entry, "pinned", null, "Manual art is protected."));
      entries.push(entry);
      continue;
    }
    const oracleId = entry.card.oracleId;
    const options = await inventory(oracleId);
    const anchor = options
      .filter(
        (p) =>
          permits(policy, p, ranks) &&
          p.illustrations.length === entry.card.faces.length,
      )
      .sort((a, b) => comparePrints(policy, a, b, true, ranks))[0];
    let candidate: Printing | undefined;
    if (anchor) {
      for (const language of languageOrder(preferences)) {
        const known = localized(anchor, options, language, policy, ranks);
        candidate =
          known && samePrintingNumber(anchor, known)
            ? known
            : localized(
                anchor,
                [...options, ...(await inventory(oracleId, language))],
                language,
                policy,
                ranks,
              );
        if (candidate) break;
      }
    }
    const result = planChange(entry, candidate, preferences, false);
    changes.push(result.change);
    entries.push(result.entry);
  }
  const changed =
    !jsonEquals(deck.artPolicy, policy) ||
    entries.some((entry, i) => entry !== deck.entries[i]);
  return {
    changes,
    next: changed ? { ...deck, artPolicy: policy, entries } : null,
  };
}

export async function planLocalization(
  provider: ReturnType<typeof policyProvider>,
  deck: Deck,
  entryId: string,
  artId: string,
  preferences: PrintLanguagePreferences,
  signal?: AbortSignal,
) {
  const request = signal ? ([{ signal }] as const) : ([] as const);
  const entry = deck.entries.find((entry) => entry.id === entryId);
  if (!entry) throw new Error("Card not found");
  const anchor = await provider.get(artId, ...request);
  let candidate: Printing | undefined;
  if (
    anchor?.oracleId === entry.card.oracleId &&
    anchor.illustrations.length === entry.card.faces.length
  ) {
    for (const language of languageOrder(preferences)) {
      candidate = localized(anchor, [anchor], language);
      if (candidate) break;
      const exact = await provider.exact(anchor, language, ...request);
      if (exact) candidate = localized(anchor, [exact], language);
      if (candidate) break;
      candidate = localized(
        anchor,
        await provider.inventory(anchor.oracleId, language, ...request),
        language,
      );
      if (candidate) break;
    }
  }
  const result = planChange(entry, candidate, preferences, true);
  return {
    changes: [result.change],
    next:
      result.entry === entry
        ? null
        : {
            ...deck,
            entries: deck.entries.map((item) =>
              item === entry ? result.entry : item,
            ),
          },
  };
}
