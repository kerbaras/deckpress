import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Compass, Eye, Import } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  api,
  type DeckQuery,
  type DeckSource,
  type DeckSummary,
  type ExternalDeck,
  type SearchField as QueryField,
  searchFields,
} from "./api.ts";
import {
  type Deck,
  type DeckEntry,
  formats,
  type ImportIssue,
  type ImportLine,
} from "./core/index.ts";
import { PageToolbar } from "./titlebar.tsx";
import {
  CardImage,
  countCards,
  ErrorNotice,
  ExternalLink,
  Loading,
  ManaPips,
  Modal,
  prettyDate,
  SearchField,
  useTask,
} from "./ui.tsx";

const MIN_QUERY = 2;
const DEBOUNCE_MS = 450;
/** Formats Archidekt can filter on; the rest of Deckpress's list has no counterpart. */
export const searchableFormats = formats.filter((format) =>
  [
    "Commander",
    "Modern",
    "Standard",
    "Pioneer",
    "Legacy",
    "Vintage",
    "Pauper",
  ].includes(format),
);
export const sourceNames: Record<DeckSource, string> = {
  archidekt: "Archidekt",
};
export const fieldNames: Record<QueryField, string> = {
  name: "Deck name",
  commander: "Commander",
  card: "Card",
};
const zoneOrder: ImportLine["zone"][] = [
  "commander",
  "main",
  "side",
  "maybe",
  "tokens",
];
const zoneNames: Record<ImportLine["zone"], string> = {
  commander: "Commander",
  main: "Main deck",
  side: "Sideboard",
  maybe: "Maybeboard",
  tokens: "Tokens",
};

export interface ZoneGroup {
  zone: ImportLine["zone"];
  name: string;
  count: number;
  lines: ImportLine[];
}

/** Groups a normalised decklist by zone in play order, dropping empty zones. */
export function groupByZone(lines: ImportLine[]): ZoneGroup[] {
  return zoneOrder.flatMap((zone) => {
    const inZone = lines.filter((line) => line.zone === zone);
    if (!inZone.length) return [];
    return [
      {
        zone,
        name: zoneNames[zone],
        count: inZone.reduce((sum, line) => sum + line.quantity, 0),
        lines: inZone,
      },
    ];
  });
}

/** Copy for the empty result state; tells the user what to change. */
export function emptyMessage(query: DeckQuery): string {
  const where = query.format ? ` in ${query.format}` : "";
  const hint =
    query.field === "name"
      ? "Try a shorter name, or search by commander or card instead."
      : query.field === "commander"
        ? "Check the commander's spelling, or search any format."
        : "Check the card name, or search any format.";
  return `No decks match “${query.text.trim()}”${where}. ${hint}`;
}

/** Deckpress format for an imported deck; anything unknown lands in Casual. */
export function deckFormat(value: string): Deck["format"] {
  const known = formats.find((format) => format === value);
  return known ?? "Casual";
}

/** Deck notes recording where an imported list came from. */
export function attribution(summary: DeckSummary): string {
  const by = summary.author ? ` by ${summary.author}` : "";
  return `Imported from ${sourceNames[summary.source]}${by}: ${summary.url}`;
}

export function DeckSearch({ open }: { open: (id: string) => void }) {
  const [text, setText] = useState("");
  const [field, setField] = useState<QueryField>("name");
  const [format, setFormat] = useState("");
  const [source, setSource] = useState<DeckSource>("archidekt");
  const [page, setPage] = useState(1);
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<DeckSummary | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchField.current?.focus();
        searchField.current?.select();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebounced(text.trim()),
      DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [text]);
  const query: DeckQuery = { text: debounced, field, format, source };
  const ready = debounced.length >= MIN_QUERY;
  const results = useQuery({
    queryKey: ["decksearch", query, page],
    queryFn: ({ signal }) => api.searchDecks(query, page, signal),
    enabled: ready,
    staleTime: 5 * 60 * 1000,
  });
  const update =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(1);
    };
  const items = results.data?.items ?? [];
  const subtitle = !ready
    ? sourceNames[source]
    : results.data
      ? `${results.data.total.toLocaleString()} ${results.data.total === 1 ? "deck" : "decks"} on ${sourceNames[source]}`
      : undefined;
  return (
    <>
      <PageToolbar title="Discover decks" subtitle={subtitle}>
        <SearchField
          ref={searchField}
          label={`Search public decks by ${fieldNames[field].toLowerCase()}`}
          value={text}
          onChange={update(setText)}
        />
        <select
          aria-label="Search by"
          value={field}
          onChange={(event) =>
            update(setField)(event.target.value as QueryField)
          }
        >
          {searchFields.map((value) => (
            <option key={value} value={value}>
              {fieldNames[value]}
            </option>
          ))}
        </select>
        <select
          aria-label="Format"
          value={format}
          onChange={(event) => update(setFormat)(event.target.value)}
        >
          <option value="">Any format</option>
          {searchableFormats.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label="Source"
          value={source}
          onChange={(event) =>
            update(setSource)(event.target.value as DeckSource)
          }
        >
          {Object.entries(sourceNames).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </PageToolbar>
      <div className="page-content library-content discover">
        <ErrorNotice
          error={results.error}
          retry={() => void results.refetch()}
        />
        {!ready ? (
          <div className="empty-state discover-intro">
            <Compass size={44} />
            <h2>Find a deck to print</h2>
            <p>
              Search public decks on {sourceNames[source]} by deck name,
              commander or a card they contain, preview the list, then import it
              as a new deck. Cards are matched on Scryfall.
            </p>
            <p className="discover-terms">
              Results are provided by {sourceNames[source]} and remain their
              authors' work. Deckpress caches responses for 24 hours.
            </p>
          </div>
        ) : results.isPending ? (
          <Loading>Searching {sourceNames[source]}…</Loading>
        ) : results.data && !items.length ? (
          <div className="empty-state">
            <Compass size={44} />
            <h2>No decks found</h2>
            <p>{emptyMessage(query)}</p>
          </div>
        ) : results.data ? (
          <>
            {results.data.matchedCard && (
              <p className="discover-matched">
                Showing decks with <strong>{results.data.matchedCard}</strong>
                {results.data.cardMatches.length > 0 && (
                  <>
                    {" · also: "}
                    {results.data.cardMatches.map((name) => (
                      <button
                        type="button"
                        className="chip"
                        key={name}
                        onClick={() => {
                          setText(name);
                          setDebounced(name);
                          setPage(1);
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </>
                )}
              </p>
            )}
            <div className="deck-grid discover-grid">
              {items.map((deck) => (
                <article className="deck-tile discover-tile" key={deck.id}>
                  {deck.coverUrl ? (
                    <CardImage
                      className="deck-cover"
                      url={deck.coverUrl}
                      name=""
                    />
                  ) : (
                    <div className="empty-cover">
                      <Compass size={52} />
                    </div>
                  )}
                  <div className="deck-shade" />
                  <button
                    type="button"
                    className="deck-open"
                    onClick={() => setSelected(deck)}
                    aria-label={`Preview ${deck.name}`}
                  />
                  <div className="deck-top">
                    <span className="deck-format">{deck.format}</span>
                    <ManaPips colors={deck.colorIdentity} />
                  </div>
                  <div className="deck-caption">
                    <h2>{deck.name}</h2>
                    <p>
                      {deck.author && <>{deck.author} · </>}
                      {deck.cardCount} cards
                      {deck.updatedAt && (
                        <> · updated {prettyDate(deck.updatedAt)}</>
                      )}
                    </p>
                    <span className="discover-source">
                      {sourceNames[deck.source]}
                    </span>
                  </div>
                </article>
              ))}
            </div>
            <nav className="toolbar discover-pager" aria-label="Result pages">
              <button
                type="button"
                className="icon-button"
                disabled={page <= 1 || results.isFetching}
                aria-label="Previous page"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <ChevronLeft size={16} />
              </button>
              <span>Page {page}</span>
              <button
                type="button"
                className="icon-button"
                disabled={!results.data.hasMore || results.isFetching}
                aria-label="Next page"
                onClick={() => setPage((current) => current + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </nav>
          </>
        ) : null}
      </div>
      {selected && (
        <DeckPreview
          summary={selected}
          onClose={() => setSelected(null)}
          open={open}
        />
      )}
    </>
  );
}

function DeckPreview({
  summary,
  onClose,
  open,
}: {
  summary: DeckSummary;
  onClose: () => void;
  open: (id: string) => void;
}) {
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["decksearch", "detail", summary.source, summary.id],
    queryFn: ({ signal }) => api.deckDetail(summary.source, summary.id, signal),
    staleTime: 5 * 60 * 1000,
  });
  const task = useTask();
  const [resolved, setResolved] = useState<{
    entries: DeckEntry[];
    issues: ImportIssue[];
  } | null>(null);
  const createDeck = async (deck: ExternalDeck, entries: DeckEntry[]) => {
    const created = await api.createDeck({
      name: deck.summary.name,
      format: deckFormat(deck.summary.deckpressFormat),
      entries,
      notes: attribution(deck.summary),
    });
    await client.invalidateQueries({ queryKey: ["decks"] });
    open(created.id);
  };
  const create = (deck: ExternalDeck, entries: DeckEntry[]) =>
    task.run(() => createDeck(deck, entries));
  const importDeck = (deck: ExternalDeck) =>
    task.run(async () => {
      const result = await api.importExternalDeck(summary.source, summary.id);
      if (result.issues.length) {
        setResolved(result);
        return;
      }
      await createDeck(deck, result.entries);
    });
  return (
    <Modal title={summary.name} onClose={onClose} busy={task.busy}>
      <div className="discover-preview">
        <p className="discover-meta">
          <span className="deck-format">{summary.format}</span>
          <ManaPips colors={summary.colorIdentity} />
          {summary.author && <span>by {summary.author}</span>}
          <span>{summary.cardCount} cards</span>
          <ExternalLink href={summary.url}>
            View on {sourceNames[summary.source]}
          </ExternalLink>
        </p>
        {detail.error ? (
          <ErrorNotice
            error={detail.error}
            retry={() => void detail.refetch()}
          />
        ) : (
          <ErrorNotice error={task.error} />
        )}
        {detail.isPending ? (
          <Loading>Loading decklist…</Loading>
        ) : detail.data ? (
          <>
            {detail.data.description && (
              <p className="discover-description">{detail.data.description}</p>
            )}
            <div className="discover-zones">
              {groupByZone(detail.data.lines).map((group) => (
                <section key={group.zone}>
                  <h3>
                    {group.name} <span>{group.count}</span>
                  </h3>
                  <ul>
                    {group.lines.map((line) => (
                      <li
                        key={`${line.zone}-${line.name}-${line.set}-${line.collectorNumber}`}
                      >
                        <span className="discover-qty">{line.quantity}</span>
                        <span>{line.name}</span>
                        {line.set && <code>{line.set.toUpperCase()}</code>}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            {resolved && (
              <div className="import-result">
                <p>
                  <Eye size={15} />
                  {countCards(resolved.entries)} of{" "}
                  {detail.data.lines.reduce(
                    (sum, line) => sum + line.quantity,
                    0,
                  )}{" "}
                  cards resolved on Scryfall
                </p>
                <div className="import-issues">
                  <strong>
                    {resolved.issues.length}{" "}
                    {resolved.issues.length === 1 ? "line needs" : "lines need"}{" "}
                    review
                  </strong>
                  {resolved.issues.map((issue) => (
                    <div key={`${issue.line}-${issue.input}-${issue.message}`}>
                      <code>{issue.input}</code>
                      <span>{issue.message}</span>
                    </div>
                  ))}
                  <p>
                    Only resolved cards will be imported. Add the missing cards
                    from the deck editor after import.
                  </p>
                </div>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" disabled={task.busy} onClick={onClose}>
                Cancel
              </button>
              {resolved ? (
                <button
                  type="button"
                  className="primary"
                  disabled={task.busy || !resolved.entries.length}
                  onClick={() =>
                    detail.data && void create(detail.data, resolved.entries)
                  }
                >
                  <Import size={16} />
                  <span>
                    Import {countCards(resolved.entries)} resolved cards
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={task.busy || !detail.data.lines.length}
                  onClick={() => detail.data && void importDeck(detail.data)}
                >
                  <Import size={16} />
                  <span>
                    {task.busy
                      ? "Resolving on Scryfall…"
                      : "Import as new deck"}
                  </span>
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
