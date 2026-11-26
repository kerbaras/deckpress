import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Download,
  FileCode,
  Image,
  LayoutGrid,
  List,
  LoaderCircle,
  Printer,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  api,
  confirmAction,
  downloadJson,
  downloadMpcXml,
  importedDeckFields,
} from "./api.ts";
import { ArtPicker } from "./art-picker.tsx";
import {
  type Art,
  type Deck,
  type DeckEntry,
  deckSchema,
  formatCount,
  formats,
  frontArt,
  mergeImport,
  mpcXmlFormat,
  type PrintJob,
  zones,
} from "./core/index.ts";
import { ImportPanel } from "./import-panel.tsx";
import { DeckLanguageSummary, entryLanguageLabel } from "./print-language.tsx";
import { PrintSetup } from "./print-setup.tsx";
import { PageToolbar } from "./titlebar.tsx";
import { TokenSuggestions } from "./token-suggestions.tsx";
import {
  CardImage,
  countCards,
  ErrorNotice,
  Loading,
  ManaPips,
  Modal,
  SearchField,
  StatusRegion,
  useTask,
  zoneNames,
} from "./ui.tsx";

type PrintSetupRequest = {
  failure: Pick<PrintJob, "failureTarget" | "message"> | undefined;
};

export function Workspace({
  id,
  printSetup,
  focusHeading,
  restoreMessage,
  onBack,
  onDirty,
  onPreviewChange,
  confirmArtExit,
  onJobs,
}: {
  id: string;
  printSetup: PrintSetupRequest | undefined;
  focusHeading: boolean;
  restoreMessage?: string | undefined;
  onBack: (trigger: HTMLButtonElement) => void;
  onDirty: (dirty: boolean) => void;
  onPreviewChange: (changed: boolean) => void;
  confirmArtExit: (trigger: HTMLButtonElement) => boolean | Promise<boolean>;
  onJobs: (job: PrintJob) => void;
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
      printSetup={printSetup}
      focusHeading={focusHeading}
      restoreMessage={restoreMessage}
      onBack={onBack}
      onDirty={onDirty}
      onPreviewChange={onPreviewChange}
      confirmArtExit={confirmArtExit}
      onJobs={onJobs}
    />
  );
}

function BackButton({
  onBack,
  disabled,
}: {
  onBack: (trigger: HTMLButtonElement) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button quiet"
      aria-label="Back to decks"
      title="Back to decks"
      disabled={disabled}
      onClick={(event) => onBack(event.currentTarget)}
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

function withEditedUpload(deck: Deck, upload: Art): Deck {
  const refresh = (art: Art | null) =>
    art?.provider === "upload" && art.id === upload.id
      ? { ...art, bleedMm: upload.bleedMm, dpi: upload.dpi }
      : art;
  const entries = deck.entries.map((entry) => {
    const selectedArt = refresh(entry.selectedArt);
    const selectedBack = refresh(entry.selectedBack);
    return selectedArt === entry.selectedArt &&
      selectedBack === entry.selectedBack
      ? entry
      : { ...entry, selectedArt, selectedBack };
  });
  return entries.every((entry, index) => entry === deck.entries[index])
    ? deck
    : { ...deck, entries };
}

function DeckWorkspace({
  initial,
  printSetup,
  focusHeading,
  restoreMessage,
  onBack,
  onDirty,
  onPreviewChange,
  confirmArtExit,
  onJobs,
}: {
  initial: Deck;
  printSetup: PrintSetupRequest | undefined;
  focusHeading: boolean;
  restoreMessage: string | undefined;
  onBack: (trigger: HTMLButtonElement) => void;
  onDirty: (dirty: boolean) => void;
  onPreviewChange: (changed: boolean) => void;
  confirmArtExit: (trigger: HTMLButtonElement) => boolean | Promise<boolean>;
  onJobs: (job: PrintJob) => void;
}) {
  const client = useQueryClient();
  const [deck, setDeck] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [previousServerDeck, setPreviousServerDeck] = useState(initial);
  const [view, setView] = useState<"edit" | "art" | "print">(
    printSetup ? "print" : "edit",
  );
  const [selectedId, setSelectedId] = useState(initial.entries[0]?.id ?? "");
  const [metadata, setMetadata] = useState(false);
  const [mpcExportStatus, setMpcExportStatus] = useState("");
  const task = useTask();
  const heading = useRef<HTMLHeadingElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const exportMpc = async () => {
    const exported = await task.run(() => {
      setMpcExportStatus("Preparing MPC Autofill XML…");
      return downloadMpcXml(deck);
    });
    setMpcExportStatus(exported ? "MPC Autofill XML saved." : "");
  };
  const saving = useRef(false);
  const [saveMode, setSaveMode] = useState<"toolbar" | "editor" | null>(null);
  const isSaving = saveMode !== null;
  if (initial !== previousServerDeck) {
    setPreviousServerDeck(initial);
    if (deck === saved && !isSaving) {
      setDeck(initial);
      setSaved(initial);
    }
  }
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  useEffect(() => {
    onDirty(deck !== saved);
    return () => onDirty(false);
  }, [deck, saved, onDirty]);
  const commit = async (next: Deck, mode: "toolbar" | "editor" = "editor") => {
    if (saving.current) throw new Error("Wait for the current save to finish");
    saving.current = true;
    setSaveMode(mode);
    try {
      const result = await api.saveDeck(deckSchema.parse(next));
      setDeck((current) =>
        mode === "toolbar" && current !== next
          ? {
              ...current,
              revision: result.revision,
              updatedAt: result.updatedAt,
            }
          : result,
      );
      setSaved(result);
      client.setQueryData(["deck", result.id], result);
      void client.invalidateQueries({ queryKey: ["decks"] });
      void client.invalidateQueries({ queryKey: ["preferences"] });
      return result;
    } finally {
      saving.current = false;
      setSaveMode(null);
    }
  };
  const dirty = deck !== saved;
  const saveStatus = isSaving ? "Saving…" : dirty ? "Unsaved changes" : "Saved";
  const SaveStatusIcon = isSaving ? LoaderCircle : dirty ? CircleAlert : Check;
  const saveChanges = () =>
    void task.run(async () => {
      await commit(deck, "toolbar");
      if (
        document.activeElement === saveButton.current ||
        document.activeElement === document.body
      )
        heading.current?.focus();
    });
  useEffect(() => {
    if (!dirty) return;
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveChanges();
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
    <fieldset
      className={`workspace workspace-${view}`}
      disabled={saveMode === "editor"}
    >
      <PageToolbar
        title={deck.name}
        titleRef={heading}
        subtitle={
          <>
            <span className="badge" data-tauri-drag-region>
              {deck.format}
            </span>
            <span className="mono" data-tauri-drag-region>
              {formatCount(countCards(deck.entries), "card")}
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
                onClick={async (event) => {
                  if (view === "art" && id !== "art") {
                    const exit = confirmArtExit(event.currentTarget);
                    if (exit === false || (exit !== true && !(await exit)))
                      return;
                  }
                  setView(id);
                }}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{name}</span>
              </button>
            ))}
          </nav>
        }
      >
        <span
          className={`save-state${isSaving ? " saving" : dirty ? " unsaved" : ""}`}
          role="status"
          aria-label={saveStatus}
          title={saveStatus}
          data-tauri-drag-region
        >
          <SaveStatusIcon
            className={isSaving ? "spin" : undefined}
            aria-hidden="true"
          />
          <span className="save-state-label" data-tauri-drag-region>
            <span data-tauri-drag-region>{saveStatus}</span>
          </span>
        </span>
        <button
          ref={saveButton}
          type="button"
          className={dirty ? "primary" : "quiet"}
          disabled={isSaving || task.busy || !dirty}
          aria-keyshortcuts="Control+S Meta+S"
          title="Save changes (Ctrl+S)"
          onClick={saveChanges}
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
          aria-label="Export MPC Autofill XML"
          title="Export MPC Autofill XML"
          disabled={task.busy || !deck.entries.length}
          onClick={() => void exportMpc()}
        >
          <FileCode size={16} />
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
      {restoreMessage && (
        <p className="notice success" aria-hidden="true">
          {restoreMessage}
        </p>
      )}
      <StatusRegion label="MPC Autofill XML export status">
        {mpcExportStatus}
      </StatusRegion>
      <ErrorNotice error={task.error} />
      {view === "edit" && (
        <div className="editor-layout">
          <ImportPanel
            existing={countCards(deck.entries)}
            onApply={async (result, replace) => {
              const { entries, missingPrints = [] } =
                importedDeckFields(result);
              await commit({
                ...deck,
                entries:
                  result.format === mpcXmlFormat
                    ? [...(replace ? [] : deck.entries), ...entries]
                    : mergeImport(deck.entries, entries, replace),
                missingPrints,
              });
              heading.current?.focus();
            }}
          />
          <DeckCards deck={deck} onChange={setDeck} onArt={selectArt} />
        </div>
      )}
      {view === "art" && selected && (
        <ArtPicker
          deck={deck}
          entry={selected}
          onSelect={setSelectedId}
          onApply={commit}
          onPreviewChange={onPreviewChange}
          onUploadEdited={(art) => {
            const nextDeck = withEditedUpload(deck, art);
            setDeck(nextDeck);
            setSaved(deck === saved ? nextDeck : withEditedUpload(saved, art));
            client.setQueriesData<Deck>({ queryKey: ["deck"] }, (current) =>
              current ? withEditedUpload(current, art) : current,
            );
            void client.invalidateQueries({ queryKey: ["decks"] });
          }}
        />
      )}
      {view === "print" && (
        <PrintSetup
          deck={deck}
          failure={printSetup?.failure}
          onChange={setDeck}
          onSave={commit}
          onJobs={onJobs}
          mpcExport={{ busy: task.busy, run: () => void exportMpc() }}
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

function boardKey(zone: DeckEntry["zone"], board?: string) {
  return board === undefined || board === zoneNames[zone]
    ? zone
    : JSON.stringify([zone, board]);
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
      <TokenSuggestions
        entries={deck.entries}
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
            {board ?? zoneNames[zone]}
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
                <CardImage url={frontArt(entry).thumbnailUrl} name="" />
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
                {orderedBoards.map(([key, { zone, board }]) => (
                  <option value={key} key={key}>
                    {board ?? zoneNames[zone]}
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
              <div
                className={display === "stacks" ? "card-stack" : "card-grid"}
              >
                {cards.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={`playing-card ${entry.selectedArt ? "custom-art" : ""} ${entry.excluded ? "excluded" : ""}`}
                    aria-label={`Choose art for ${entry.card.name}`}
                    aria-description={entryLanguageLabel(entry)}
                    title={entryLanguageLabel(entry)}
                    onClick={() => onArt(entry)}
                  >
                    <CardImage
                      url={frontArt(entry).thumbnailUrl}
                      name={entry.card.name}
                    />
                    <span className="quantity">{entry.quantity}</span>
                    <span className="badge card-language">
                      {entryLanguageLabel(entry)}
                    </span>
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
            Art chosen for{" "}
            {countCards(deck.entries.filter((entry) => entry.selectedArt))} of{" "}
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
