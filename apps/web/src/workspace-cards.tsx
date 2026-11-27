import {
  Image,
  LayoutGrid,
  List,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { confirmAction, importedDeckFields } from "./api.ts";
import {
  type Deck,
  type DeckEntry,
  deckSchema,
  formatCount,
  frontArt,
  hasChosenArt,
  mergeImport,
  mpcXmlFormat,
  zones,
} from "./core/index.ts";
import { ImportPanel } from "./import-panel.tsx";
import { DeckLanguageSummary, entryLanguageLabel } from "./print-language.tsx";
import { useStackHoverIntent } from "./stack-hover-intent.ts";
import { TokenSuggestions } from "./token-suggestions.tsx";
import {
  ArtThumbnail,
  countCards,
  ErrorNotice,
  ManaPips,
  SearchField,
  zoneLabel,
  zoneNames,
} from "./ui.tsx";

let stackLanguageObserver: ResizeObserver | undefined;

function updateStackLanguageBadges(badges: ResizeObserverEntry[]) {
  for (const { target } of badges) {
    const card = target.parentElement;
    const stack = card?.parentElement;
    if (!card || !stack) continue;
    const stripHeight = Number.parseFloat(getComputedStyle(stack).gridAutoRows);
    const badgeBottom =
      target.getBoundingClientRect().bottom - card.getBoundingClientRect().top;
    target.toggleAttribute("data-in-stack-strip", badgeBottom <= stripHeight);
  }
}

function observeStackLanguageBadge(badge: HTMLSpanElement | null) {
  if (!badge || typeof ResizeObserver === "undefined") return;
  stackLanguageObserver ??= new ResizeObserver(updateStackLanguageBadges);
  const observer = stackLanguageObserver;
  observer.observe(badge, { box: "border-box" });
  return () => observer.unobserve(badge);
}

function boardKey(zone: DeckEntry["zone"], board?: string) {
  return board === undefined || board === zoneNames[zone]
    ? zone
    : JSON.stringify([zone, board]);
}

export function WorkspaceEditor({
  deck,
  onChange,
  onArt,
  onCommit,
}: {
  deck: Deck;
  onChange: (deck: Deck) => void;
  onArt: (entry: DeckEntry) => void;
  onCommit: (deck: Deck) => Promise<void>;
}) {
  return (
    <div className="editor-layout">
      <ImportPanel
        key={deck.printLanguage ?? "default"}
        deckId={deck.printLanguage ? deck.id : undefined}
        existing={countCards(deck.entries)}
        onApply={async (result, replace) => {
          const { entries, missingPrints = [] } = importedDeckFields(result);
          await onCommit({
            ...deck,
            entries:
              result.format === mpcXmlFormat
                ? [...(replace ? [] : deck.entries), ...entries]
                : mergeImport(deck.entries, entries, replace),
            missingPrints,
          });
        }}
      />
      <DeckCards deck={deck} onChange={onChange} onArt={onArt} />
    </div>
  );
}

function DeckCards({
  deck,
  onChange,
  onArt,
}: {
  deck: Deck;
  onChange: (deck: Deck) => void;
  onArt: (entry: DeckEntry) => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedBoard, setSelectedBoard] = useState("main");
  const [group, setGroup] = useState("mana");
  const [display, setDisplay] = useState("stacks");
  const [error, setError] = useState<unknown>(null);
  const update = (id: string, change: Partial<DeckEntry>) => {
    const next = {
      ...deck,
      entries: deck.entries.map((entry) =>
        entry.id === id ? { ...entry, ...change } : entry,
      ),
    };
    const parsed = deckSchema.safeParse(next);
    if (parsed.success) {
      setError(null);
      onChange(parsed.data);
    } else
      setError(new Error(parsed.error.issues[0]?.message ?? "Invalid deck"));
  };
  const boards = new Map(
    zones.map((zone) => [
      boardKey(zone),
      { zone, board: undefined as string | undefined, count: 0 },
    ]),
  );
  for (const { zone, board, quantity } of deck.entries) {
    const key = boardKey(zone, board);
    const existing = boards.get(key);
    if (existing) existing.count += quantity;
    else boards.set(key, { zone, board, count: quantity });
  }
  const orderedBoards = [...boards].sort(
    ([, left], [, right]) =>
      zones.indexOf(left.zone) - zones.indexOf(right.zone),
  );
  const activeBoard = boards.has(selectedBoard) ? selectedBoard : "main";
  const entries = deck.entries.filter(
    (entry) =>
      boardKey(entry.zone, entry.board) === activeBoard &&
      entry.card.name.toLowerCase().includes(search.toLowerCase()),
  );
  const groups = new Map<string, DeckEntry[]>();
  for (const entry of [...entries].sort(
    (a, b) =>
      a.card.manaValue - b.card.manaValue ||
      a.card.name.localeCompare(b.card.name),
  )) {
    const label =
      group === "art"
        ? hasChosenArt(entry)
          ? "Chosen art"
          : "Original printing"
        : group === "type"
          ? (entry.card.typeLine.split(" — ")[0] ?? "Other")
          : entry.card.typeLine.includes("Land")
            ? "Lands"
            : `${entry.card.manaValue} mana`;
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }
  return (
    <section className="deck-cards">
      <TokenSuggestions
        entries={deck.entries}
        languageDeck={
          deck.printLanguage
            ? { id: deck.id, revision: deck.revision }
            : undefined
        }
        onAdd={(entry) => {
          const next = deckSchema.safeParse({
            ...deck,
            entries: [...deck.entries, entry],
          });
          if (!next.success) {
            setError(
              new Error(next.error.issues[0]?.message ?? "Invalid deck"),
            );
            return;
          }
          setError(null);
          onChange(next.data);
          setSelectedBoard("tokens");
          setSearch("");
        }}
      />
      <div className="toolbar zone-toolbar">
        {orderedBoards.map(([key, { zone, board, count }]) => (
          <button
            type="button"
            key={key}
            className={key === activeBoard ? "chip active" : "chip"}
            onClick={() => setSelectedBoard(key)}
          >
            {board ?? zoneLabel(zone, count)}
            <span>{count}</span>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <SearchField value={search} onChange={setSearch} label="Find a card" />
        <label className="inline-label">
          Group
          <select
            aria-label="Group cards"
            value={group}
            onChange={(event) => setGroup(event.target.value)}
          >
            <option value="mana">Mana value</option>
            <option value="type">Card type</option>
            <option value="art">Art status</option>
          </select>
        </label>
        <div className="spacer" />
        <div className="segmented">
          <button
            type="button"
            aria-label="Stacks view"
            aria-pressed={display === "stacks"}
            onClick={() => setDisplay("stacks")}
          >
            <List size={16} />
          </button>
          <button
            type="button"
            aria-label="Card grid"
            aria-pressed={display === "grid"}
            onClick={() => setDisplay("grid")}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            type="button"
            aria-label="Edit card quantities"
            aria-pressed={display === "list"}
            onClick={() => setDisplay("list")}
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>
      </div>
      <ErrorNotice error={error} />
      <DeckLanguageSummary deck={deck} />
      {!entries.length ? (
        <div className="empty-state">
          <Image size={35} />
          <h2>
            {deck.entries.length
              ? "No cards here yet"
              : "Your deck starts here"}
          </h2>
          <p>
            {deck.entries.length
              ? "Choose another board or import more cards."
              : "Paste a list on the left, resolve it on Scryfall, then make it yours."}
          </p>
        </div>
      ) : display === "list" ? (
        <div className="entry-table">
          <div className="entry-table-head">
            <span>Card</span>
            <span>Copies</span>
            <span>Board</span>
            <span>Print</span>
            <span />
          </div>
          {entries.map((entry) => (
            <div className="entry-row" key={entry.id}>
              <button
                type="button"
                className="entry-name"
                onClick={() => onArt(entry)}
              >
                <ArtThumbnail art={frontArt(entry)} name="" />
                <span>
                  {entry.card.name}
                  <small>{frontArt(entry).source}</small>
                  <span className="badge">{entryLanguageLabel(entry)}</span>
                </span>
              </button>
              <input
                type="number"
                aria-label={`Copies of ${entry.card.name}`}
                min={1}
                max={250}
                value={entry.quantity}
                onChange={(event) =>
                  update(entry.id, { quantity: Number(event.target.value) })
                }
              />
              <select
                aria-label={`Board for ${entry.card.name}`}
                value={boardKey(entry.zone, entry.board)}
                onChange={(event) => {
                  const target = boards.get(event.target.value);
                  if (target)
                    update(entry.id, {
                      zone: target.zone,
                      board: target.board,
                    });
                }}
              >
                {orderedBoards.map(([key, { zone, board, count }]) => (
                  <option value={key} key={key}>
                    {board ?? zoneLabel(zone, count)}
                  </option>
                ))}
              </select>
              <input
                type="checkbox"
                aria-label={`Print ${entry.card.name}`}
                checked={!entry.excluded}
                onChange={(event) =>
                  update(entry.id, { excluded: !event.target.checked })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${entry.card.name}`}
                onClick={async () => {
                  if (
                    await confirmAction(
                      `Remove ${entry.quantity > 1 ? "all " : ""}${formatCount(entry.quantity, "copy", "copies")} of ${entry.card.name}?`,
                      "Remove",
                    )
                  )
                    onChange({
                      ...deck,
                      entries: deck.entries.filter(
                        (item) => item.id !== entry.id,
                      ),
                    });
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div
          className={
            display === "stacks" ? "card-groups" : "card-groups grid-groups"
          }
        >
          {[...groups].map(([label, cards]) => (
            <section className="card-group" key={label}>
              <div className="group-heading">
                <h3>{label}</h3>
                <span>{countCards(cards)}</span>
              </div>
              <CardTiles
                key={display}
                stacked={display === "stacks"}
                cards={cards}
                onArt={onArt}
              />
            </section>
          ))}
        </div>
      )}
      <div className="deck-summary">
        <span className="status-dot" />
        <div>
          <strong>
            Art chosen for {countCards(deck.entries.filter(hasChosenArt))} of{" "}
            {formatCount(countCards(deck.entries), "card")}
          </strong>
          <p>
            Cards without custom art use the image they were imported with.
            Click any card to compare editions.
          </p>
        </div>
        <div className="spacer" />
        <ManaPips
          colors={["W", "U", "B", "R", "G"].filter((color) =>
            deck.entries.some((entry) => entry.card.colors.includes(color)),
          )}
        />
      </div>
    </section>
  );
}

function CardTiles({
  stacked,
  cards,
  onArt,
}: {
  stacked: boolean;
  cards: DeckEntry[];
  onArt: (entry: DeckEntry) => void;
}) {
  const intent = useStackHoverIntent();
  return (
    <div
      className={stacked ? "card-stack" : "card-grid"}
      onPointerEnter={stacked ? intent.onPointerEnterStack : undefined}
      onPointerLeave={stacked ? intent.onPointerLeaveStack : undefined}
    >
      {cards.map((entry) => (
        <button
          type="button"
          key={entry.id}
          className={`playing-card ${hasChosenArt(entry) ? "custom-art" : ""} ${entry.excluded ? "excluded" : ""} ${stacked && intent.raisedId === entry.id ? "raised" : ""}`}
          aria-label={`Choose art for ${entry.card.name}`}
          aria-description={entryLanguageLabel(entry)}
          title={entryLanguageLabel(entry)}
          onClick={() => onArt(entry)}
          onPointerEnter={
            stacked ? () => intent.onPointerEnterCard(entry.id) : undefined
          }
          onFocus={
            stacked
              ? (event) => {
                  if (event.currentTarget.matches(":focus-visible"))
                    intent.onFocusCard(entry.id);
                }
              : undefined
          }
          onBlur={stacked ? () => intent.onBlurCard(entry.id) : undefined}
        >
          <ArtThumbnail art={frontArt(entry)} name={entry.card.name} />
          <span className="quantity">{entry.quantity}</span>
          <span
            className="badge card-language"
            ref={stacked ? observeStackLanguageBadge : undefined}
          >
            {entryLanguageLabel(entry)}
          </span>
          {entry.excluded && <span className="card-status">Not printing</span>}
        </button>
      ))}
    </div>
  );
}
