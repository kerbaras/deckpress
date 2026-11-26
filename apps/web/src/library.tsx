import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Download,
  FolderOpen,
  LayoutGrid,
  List,
  Plus,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, downloadJson } from "./api.ts";
import { type Deck, deckSchema, formats, frontArt } from "./core/index.ts";
import { FirstRun } from "./first-run.tsx";
import { PageToolbar } from "./titlebar.tsx";
import {
  CardImage,
  countCards,
  ErrorNotice,
  Loading,
  ManaPips,
  Modal,
  prettyDate,
  SearchField,
  useTask,
} from "./ui.tsx";

export function Library({
  open,
  openImported,
  createRequest = 0,
  onCreateHandled,
  onBuild,
}: {
  open: (id: string) => void;
  openImported: (id: string, importedCards?: number) => void;
  /** Bumped by the title bar's "New deck" action; opens the create dialog. */
  createRequest?: number;
  onCreateHandled?: () => void;
  /** Opens the guided deck builder instead of an empty deck. */
  onBuild?: () => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["decks"],
    queryFn: ({ signal }) => api.decks(signal),
  });
  const task = useTask();
  const [search, setSearch] = useState("");
  const [format, setFormat] = useState("All");
  const [sort, setSort] = useState("recent");
  const [list, setList] = useState(false);
  const [create, setCreate] = useState(false);
  const [remove, setRemove] = useState<Deck | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (createRequest > 0) {
      setCreate(true);
      onCreateHandled?.();
    }
  }, [createRequest, onCreateHandled]);
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
  const decks = query.data ?? [];
  const shown = decks
    .filter(
      (deck) =>
        (format === "All" || deck.format === format) &&
        `${deck.name} ${deck.format} ${deck.entries.map((entry) => entry.card.name).join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "coverage"
          ? coverage(b) - coverage(a)
          : b.updatedAt.localeCompare(a.updatedAt),
    );
  const refresh = () => client.invalidateQueries({ queryKey: ["decks"] });
  return (
    <>
      <PageToolbar
        title="Decks"
        subtitle={
          decks.length
            ? `${decks.length} ${decks.length === 1 ? "deck" : "decks"}`
            : undefined
        }
      >
        <SearchField
          compact
          ref={searchField}
          label="Search decks, formats, cards"
          value={search}
          onChange={setSearch}
        />
        <label
          className="button icon-button quiet"
          title="Restore a deck from a JSON backup"
        >
          <Upload size={16} />
          <span className="sr-only">Restore a deck from a JSON backup</span>
          <input
            className="sr-only"
            type="file"
            accept=".json"
            disabled={task.busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file)
                void task.run(async () => {
                  if (file.size > 16 * 1024 * 1024)
                    throw new Error("Deck backup exceeds 16 MB");
                  const original = deckSchema.parse(
                    JSON.parse(await file.text()),
                  );
                  const deck = await api.createDeck(original);
                  await refresh();
                  openImported(deck.id);
                });
              event.target.value = "";
            }}
          />
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => setCreate(true)}
        >
          <Plus size={16} />
          <span>New deck</span>
        </button>
      </PageToolbar>
      <div className="page-content library-content">
        <ErrorNotice
          error={query.error ?? task.error}
          retry={() => void query.refetch()}
        />
        {decks.length > 0 && (
          <div className="toolbar">
            <div className="chips">
              {[
                "All",
                ...formats.filter((value) =>
                  decks.some((deck) => deck.format === value),
                ),
              ].map((value) => (
                <button
                  type="button"
                  className={value === format ? "chip active" : "chip"}
                  aria-pressed={value === format}
                  onClick={() => setFormat(value)}
                  key={value}
                >
                  {value}
                  <span>
                    {value === "All"
                      ? decks.length
                      : decks.filter((deck) => deck.format === value).length}
                  </span>
                </button>
              ))}
            </div>
            <div className="spacer" />
            <label className="inline-label">
              Sort
              <select
                aria-label="Sort decks"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="recent">Recently edited</option>
                <option value="name">Name</option>
                <option value="coverage">Art coverage</option>
              </select>
            </label>
            <div className="segmented">
              <button
                type="button"
                aria-label="Tile view"
                aria-pressed={!list}
                onClick={() => setList(false)}
              >
                <LayoutGrid size={16} />
              </button>
              <button
                type="button"
                aria-label="List view"
                aria-pressed={list}
                onClick={() => setList(true)}
              >
                <List size={16} />
              </button>
            </div>
          </div>
        )}
        {query.isPending ? (
          <Loading>Opening your library…</Loading>
        ) : decks.length === 0 && !query.isError ? (
          <FirstRun
            onCreate={() => setCreate(true)}
            {...(onBuild ? { onBuild } : {})}
            onSaved={async (deck) => {
              await refresh();
              openImported(deck.id, countCards(deck.entries));
            }}
          />
        ) : (
          <div className={list ? "deck-grid list-mode" : "deck-grid"}>
            {shown.map((deck) => {
              const coverEntry =
                deck.entries.find((entry) => entry.id === deck.coverEntryId) ??
                deck.entries.find((entry) => entry.zone === "commander") ??
                deck.entries[0];
              const cover = coverEntry ? frontArt(coverEntry) : null;
              const customized = countCards(
                deck.entries.filter((entry) => entry.selectedArt),
              );
              const colors = ["W", "U", "B", "R", "G"].filter((color) =>
                deck.entries.some((entry) => entry.card.colors.includes(color)),
              );
              return (
                <article className="deck-tile" key={deck.id}>
                  {cover ? (
                    <CardImage
                      className={`deck-cover ${cover.artCropUrl ? "" : "scan-cover"}`}
                      url={cover.artCropUrl || cover.imageUrl}
                      name=""
                    />
                  ) : (
                    <div className="empty-cover">
                      <FolderOpen size={52} />
                    </div>
                  )}
                  <div className="deck-shade" />
                  <button
                    type="button"
                    className="deck-open"
                    onClick={() => open(deck.id)}
                    aria-label={`Open ${deck.name}`}
                  />
                  <div className="deck-top">
                    <span className="deck-format">{deck.format}</span>
                    <ManaPips colors={colors} />
                  </div>
                  <div className="deck-caption">
                    <h2>{deck.name}</h2>
                    <p>
                      {countCards(deck.entries)} cards · edited{" "}
                      {prettyDate(deck.updatedAt)}
                    </p>
                    <div className="coverage">
                      <span className="coverage-track">
                        <span style={{ width: `${coverage(deck)}%` }} />
                      </span>
                      <span>
                        {customized} / {countCards(deck.entries)} art
                      </span>
                    </div>
                  </div>
                  <div className="deck-actions">
                    <button
                      type="button"
                      aria-label={`Back up ${deck.name}`}
                      title="Back up deck JSON"
                      onClick={() => void downloadJson(deck)}
                    >
                      <Download size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Duplicate ${deck.name}`}
                      title="Duplicate deck"
                      disabled={task.busy}
                      onClick={() =>
                        void task.run(async () => {
                          await api.createDeck({
                            ...deck,
                            name: `${deck.name.slice(0, 93)} copy`,
                          });
                          await refresh();
                        })
                      }
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${deck.name}`}
                      title="Delete deck"
                      onClick={() => setRemove(deck)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {!query.isPending && decks.length > 0 && shown.length === 0 && (
          <div className="empty-state">
            <h2>No matching decks</h2>
            <p>
              Nothing matches “{search}”
              {format === "All" ? "" : ` in ${format}`}.
            </p>
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setFormat("All");
              }}
            >
              Clear filters
            </button>
          </div>
        )}
        <footer className="library-footer">
          <span>Personal playtest proxies. Not for sale.</span>
        </footer>
      </div>
      {create && (
        <NewDeck
          onClose={() => setCreate(false)}
          {...(onBuild
            ? {
                onBuild: () => {
                  setCreate(false);
                  onBuild();
                },
              }
            : {})}
          onCreated={(deck) => {
            void refresh();
            open(deck.id);
          }}
        />
      )}
      {remove && (
        <Modal
          title="Delete this deck?"
          busy={task.busy}
          onClose={() => setRemove(null)}
        >
          <p>
            Delete “{remove.name}” from this machine? Download a backup first if
            you want to keep its art choices.
          </p>
          <ErrorNotice error={task.error} />
          <div className="modal-actions">
            <button type="button" onClick={() => void downloadJson(remove)}>
              Back up JSON
            </button>
            <button
              type="button"
              className="danger"
              disabled={task.busy}
              onClick={() =>
                void task.run(async () => {
                  await api.deleteDeck(remove.id);
                  setRemove(null);
                  await refresh();
                })
              }
            >
              Delete deck
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function coverage(deck: Deck) {
  return (
    (countCards(deck.entries.filter((entry) => entry.selectedArt)) /
      Math.max(1, countCards(deck.entries))) *
    100
  );
}

function NewDeck({
  onClose,
  onCreated,
  onBuild,
}: {
  onClose: () => void;
  onCreated: (deck: Deck) => void;
  onBuild?: () => void;
}) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState<Deck["format"]>("Commander");
  const task = useTask();
  return (
    <Modal title="New deck" onClose={onClose} busy={task.busy}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () =>
            onCreated(await api.createDeck({ name: name.trim(), format })),
          );
        }}
      >
        <p className="muted">
          Start with a name. Add your list in the deck editor.
        </p>
        <label className="field">
          Deck name
          <input
            ref={(input) => input?.setAttribute("autofocus", "")}
            required
            maxLength={100}
            placeholder="Your next favorite deck"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          Format
          <select
            value={format}
            onChange={(event) =>
              setFormat(event.target.value as Deck["format"])
            }
          >
            {formats.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <ErrorNotice error={task.error} />
        <div className="modal-actions">
          {onBuild && (
            <button
              type="button"
              className="new-deck-build"
              title="Pick a format, colours and theme, then choose from scored suggestions"
              onClick={onBuild}
            >
              <Wand2 size={15} />
              Build with suggestions
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={task.busy || !name.trim()}
          >
            {task.busy ? "Creating…" : "Create deck"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
