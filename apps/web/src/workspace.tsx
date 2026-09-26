import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Download,
  Image,
  LayoutGrid,
  List,
  Printer,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, confirmAction, downloadJson } from "./api.ts";
import { ArtPicker } from "./art-picker.tsx";
import {
  type Deck,
  type DeckEntry,
  deckSchema,
  formats,
  frontArt,
  mergeImport,
  zones,
} from "./core/index.ts";
import { ImportPanel } from "./import-panel.tsx";
import { PrintSetup } from "./print-setup.tsx";
import { PageToolbar } from "./titlebar.tsx";
import {
  CardImage,
  countCards,
  ErrorNotice,
  Loading,
  ManaPips,
  Modal,
  SearchField,
  useTask,
  zoneNames,
} from "./ui.tsx";

export function Workspace({
  id,
  onBack,
  onDirty,
  onJobs,
}: {
  id: string;
  onBack: () => void;
  onDirty: (dirty: boolean) => void;
  onJobs: () => void;
}) {
  const query = useQuery({
    queryKey: ["deck", id],
    queryFn: ({ signal }) => api.deck(id, signal),
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <Loading>Opening deck…</Loading>;
  if (!query.data)
    return (
      <>
        <PageToolbar title="Deck" leading={<BackButton onBack={onBack} />} />
        <div className="page-content">
          <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        </div>
      </>
    );
  return (
    <DeckWorkspace
      initial={query.data}
      onBack={onBack}
      onDirty={onDirty}
      onJobs={onJobs}
    />
  );
}

function BackButton({
  onBack,
  disabled,
}: {
  onBack: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button quiet"
      aria-label="Back to decks"
      title="Back to decks"
      disabled={disabled}
      onClick={onBack}
    >
      <ArrowLeft size={16} />
    </button>
  );
}

const views = [
  { id: "edit", name: "Deck editor", icon: List },
  { id: "art", name: "Art studio", icon: Image },
  { id: "print", name: "Print setup", icon: Printer },
] as const;

function DeckWorkspace({
  initial,
  onBack,
  onDirty,
  onJobs,
}: {
  initial: Deck;
  onBack: () => void;
  onDirty: (dirty: boolean) => void;
  onJobs: () => void;
}) {
  const client = useQueryClient();
  const [deck, setDeck] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [view, setView] = useState<"edit" | "art" | "print">("edit");
  const [selectedId, setSelectedId] = useState(initial.entries[0]?.id ?? "");
  const [metadata, setMetadata] = useState(false);
  const task = useTask();
  const saving = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  useEffect(() => {
    onDirty(deck !== saved);
    return () => onDirty(false);
  }, [deck, saved, onDirty]);
  const commit = async (next: Deck) => {
    if (saving.current) throw new Error("Wait for the current save to finish");
    saving.current = true;
    setIsSaving(true);
    try {
      const result = await api.saveDeck(deckSchema.parse(next));
      setDeck(result);
      setSaved(result);
      client.setQueryData(["deck", result.id], result);
      void client.invalidateQueries({ queryKey: ["decks"] });
      void client.invalidateQueries({ queryKey: ["preferences"] });
      return result;
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  };
  const dirty = deck !== saved;
  useEffect(() => {
    if (!dirty) return;
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!task.busy) void task.run(() => commit(deck));
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  const selectArt = (entry: DeckEntry) => {
    setSelectedId(entry.id);
    setView("art");
  };
  const selected =
    deck.entries.find((entry) => entry.id === selectedId) ?? deck.entries[0];
  return (
    <fieldset className={`workspace workspace-${view}`} disabled={isSaving}>
      <PageToolbar
        title={deck.name}
        subtitle={
          <>
            <span className="badge" data-tauri-drag-region>
              {deck.format}
            </span>
            <span className="mono" data-tauri-drag-region>
              {countCards(deck.entries)} cards
            </span>
          </>
        }
        leading={<BackButton onBack={onBack} disabled={isSaving} />}
        center={
          <nav
            className="segmented workspace-views"
            aria-label="Deck workspace"
          >
            {views.map(({ id, name, icon: Icon }) => (
              <button
                type="button"
                key={id}
                disabled={isSaving || (id !== "edit" && !deck.entries.length)}
                aria-current={view === id ? "page" : undefined}
                title={name}
                onClick={() => setView(id)}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{name}</span>
              </button>
            ))}
          </nav>
        }
      >
        <span
          className={dirty ? "save-state unsaved" : "save-state"}
          role="status"
          data-tauri-drag-region
        >
          {dirty ? (
            "Unsaved changes"
          ) : (
            <>
              <Check size={13} aria-hidden="true" />
              Saved
            </>
          )}
        </span>
        <button
          type="button"
          className={dirty ? "primary" : "quiet"}
          disabled={task.busy || !dirty}
          aria-keyshortcuts="Control+S Meta+S"
          title="Save changes (Ctrl+S)"
          onClick={() => void task.run(() => commit(deck))}
        >
          <Save size={15} />
          Save changes
        </button>
        <button
          type="button"
          className="icon-button quiet"
          aria-label="Back up deck as JSON"
          title="Back up deck as JSON"
          disabled={isSaving}
          onClick={() => void downloadJson(deck)}
        >
          <Download size={16} />
        </button>
        <button
          type="button"
          className="icon-button quiet"
          aria-label="Deck settings"
          title="Deck settings"
          disabled={isSaving}
          onClick={() => setMetadata(true)}
        >
          <SlidersHorizontal size={16} />
        </button>
      </PageToolbar>
      <ErrorNotice error={task.error} />
      {view === "edit" && (
        <div className="editor-layout">
          <ImportPanel
            existing={deck.entries.length}
            onApply={async (result, replace) => {
              await commit({
                ...deck,
                entries: mergeImport(deck.entries, result.entries, replace),
              });
            }}
          />
          <DeckCards deck={deck} onChange={setDeck} onArt={selectArt} />
        </div>
      )}
      {view === "art" && selected && (
        <ArtPicker
          key={selected.id}
          deck={deck}
          entry={selected}
          onSelect={setSelectedId}
          onApply={commit}
        />
      )}
      {view === "print" && (
        <PrintSetup
          deck={deck}
          onChange={setDeck}
          onSave={commit}
          onJobs={onJobs}
        />
      )}
      {metadata && (
        <Modal
          title="Deck settings"
          busy={task.busy}
          onClose={() => setMetadata(false)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void task.run(async () => {
                await commit(deck);
                setMetadata(false);
              });
            }}
          >
            <label className="field">
              Deck name
              <input
                required
                maxLength={100}
                value={deck.name}
                onChange={(event) =>
                  setDeck({ ...deck, name: event.target.value })
                }
              />
            </label>
            <label className="field">
              Format
              <select
                value={deck.format}
                onChange={(event) =>
                  setDeck({
                    ...deck,
                    format: event.target.value as Deck["format"],
                  })
                }
              >
                {formats.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Notes
              <textarea
                maxLength={5000}
                rows={4}
                value={deck.notes}
                onChange={(event) =>
                  setDeck({ ...deck, notes: event.target.value })
                }
                placeholder="Playgroup, theme, printing notes…"
              />
            </label>
            <label className="field">
              Cover card
              <select
                value={deck.coverEntryId}
                onChange={(event) =>
                  setDeck({ ...deck, coverEntryId: event.target.value })
                }
              >
                <option value="">Automatic</option>
                {deck.entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.card.name}
                  </option>
                ))}
              </select>
            </label>
            <ErrorNotice error={task.error} />
            <div className="modal-actions">
              <button
                type="submit"
                className="primary"
                disabled={task.busy || !deck.name.trim()}
              >
                Save deck settings
              </button>
            </div>
          </form>
        </Modal>
      )}
    </fieldset>
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
  const [zone, setZone] = useState<DeckEntry["zone"]>("main");
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
  const entries = deck.entries.filter(
    (entry) =>
      entry.zone === zone &&
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
        ? entry.selectedArt
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
      <div className="toolbar zone-toolbar">
        {zones.map((value) => (
          <button
            type="button"
            key={value}
            className={value === zone ? "chip active" : "chip"}
            onClick={() => setZone(value)}
          >
            {zoneNames[value]}
            <span>
              {countCards(deck.entries.filter((entry) => entry.zone === value))}
            </span>
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
                <CardImage url={frontArt(entry).thumbnailUrl} name="" />
                <span>
                  {entry.card.name}
                  <small>{frontArt(entry).source}</small>
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
                value={entry.zone}
                onChange={(event) =>
                  update(entry.id, {
                    zone: event.target.value as DeckEntry["zone"],
                  })
                }
              >
                {zones.map((value) => (
                  <option value={value} key={value}>
                    {zoneNames[value]}
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
                      `Remove all ${entry.quantity} copies of ${entry.card.name}?`,
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
              <div
                className={display === "stacks" ? "card-stack" : "card-grid"}
              >
                {cards.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={`playing-card ${entry.selectedArt ? "custom-art" : ""} ${entry.excluded ? "excluded" : ""}`}
                    aria-label={`Choose art for ${entry.card.name}`}
                    onClick={() => onArt(entry)}
                  >
                    <CardImage
                      url={frontArt(entry).thumbnailUrl}
                      name={entry.card.name}
                    />
                    <span className="quantity">{entry.quantity}</span>
                    {entry.excluded && (
                      <span className="card-status">Not printing</span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <div className="deck-summary">
        <span className="status-dot" />
        <div>
          <strong>
            {countCards(deck.entries.filter((entry) => entry.selectedArt))} of{" "}
            {countCards(deck.entries)} cards have chosen art
          </strong>
          <p>
            Unchanged cards use the original Scryfall printing. Click any card
            to compare editions.
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
