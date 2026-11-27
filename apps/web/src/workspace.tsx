import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, downloadMpcXml } from "./api.ts";
import { ArtPicker } from "./art-picker.tsx";
import { ArtPreviewDialog } from "./art-policy.tsx";
import {
  type Art,
  type Deck,
  type DeckEntry,
  deckSchema,
  type PrintJob,
} from "./core/index.ts";
import { DeckLanguageControl, DeckLanguagePreview } from "./deck-language.tsx";
import { PrintSetup } from "./print-setup.tsx";
import { PageToolbar } from "./titlebar.tsx";
import { ErrorNotice, StatusRegion, UnkeyedLoading, useTask } from "./ui.tsx";
import {
  type RegisterPolicyPreview,
  useWorkspaceArt,
} from "./use-workspace-art.ts";
import { WorkspaceEditor } from "./workspace-cards.tsx";
import {
  BackButton,
  DeckSettings,
  WorkspaceToolbar,
  type WorkspaceView,
} from "./workspace-controls.tsx";

type PrintSetupRequest = {
  failure: Pick<PrintJob, "failureTarget" | "message"> | undefined;
};

const ignoreEditionsLoading = () => {};

export function Workspace({
  id,
  printSetup,
  focusHeading,
  restoreMessage,
  onBack,
  onDirty,
  onPreviewChange,
  registerPolicyPreview,
  onEditionsLoading = ignoreEditionsLoading,
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
  registerPolicyPreview: RegisterPolicyPreview;
  onEditionsLoading?: (active: boolean) => void;
  confirmArtExit: (trigger: HTMLButtonElement) => boolean | Promise<boolean>;
  onJobs: (job: PrintJob) => void;
}) {
  const query = useQuery({
    queryKey: ["deck", id],
    queryFn: ({ signal }) => api.deck(id, signal),
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <UnkeyedLoading>Opening deck…</UnkeyedLoading>;
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
      registerPolicyPreview={registerPolicyPreview}
      onEditionsLoading={onEditionsLoading}
      confirmArtExit={confirmArtExit}
      onJobs={onJobs}
    />
  );
}

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
  registerPolicyPreview,
  onEditionsLoading,
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
  registerPolicyPreview: RegisterPolicyPreview;
  onEditionsLoading: (active: boolean) => void;
  confirmArtExit: (trigger: HTMLButtonElement) => boolean | Promise<boolean>;
  onJobs: (job: PrintJob) => void;
}) {
  const client = useQueryClient();
  const [deck, setDeck] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [previousServerDeck, setPreviousServerDeck] = useState(initial);
  const [view, setView] = useState<WorkspaceView>(
    printSetup ? "print" : "edit",
  );
  const [selectedId, setSelectedId] = useState(initial.entries[0]?.id ?? "");
  const [metadata, setMetadata] = useState(false);
  const [preserveStudioPreview, setPreserveStudioPreview] = useState(false);
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
  const writeDeck = async (
    save: () => Promise<Deck>,
    {
      toolbarDeck,
      preservePreview = false,
    }: { toolbarDeck?: Deck; preservePreview?: boolean } = {},
  ) => {
    if (saving.current) throw new Error("Wait for the current save to finish");
    saving.current = true;
    setSaveMode(toolbarDeck ? "toolbar" : "editor");
    try {
      const result = await save();
      setPreserveStudioPreview(preservePreview);
      setDeck((current) =>
        toolbarDeck && current !== toolbarDeck
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
  const commit = (next: Deck, mode: "toolbar" | "editor" = "editor") =>
    writeDeck(
      () => api.saveDeck(deckSchema.parse(next)),
      mode === "toolbar" ? { toolbarDeck: next } : undefined,
    );
  const dirty = deck !== saved;
  const art = useWorkspaceArt({
    deck,
    dirty,
    isSaving,
    saving,
    metadata,
    registerPolicyPreview,
    writeDeck,
  });
  const {
    artPreview,
    artTask,
    canUndoArt,
    undoLanguage,
    artStatus,
    previewPolicy,
    previewLanguage,
    previewLocalization,
    overrideLanguage,
    keepArt,
    applyArt,
    undoArt,
  } = art;
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
      <WorkspaceToolbar
        deck={deck}
        view={view}
        setView={setView}
        onBack={onBack}
        confirmArtExit={confirmArtExit}
        isSaving={isSaving}
        dirty={dirty}
        busy={task.busy}
        heading={heading}
        saveButton={saveButton}
        saveChanges={saveChanges}
        onExportMpc={() => void exportMpc()}
        onSettings={() => setMetadata(true)}
      />
      {view !== "art" && (
        <DeckLanguageControl
          language={deck.printLanguage}
          disabled={dirty || isSaving || task.busy || artTask.busy}
          onSelect={previewLanguage}
          onUndo={canUndoArt && undoLanguage ? undoArt : undefined}
        />
      )}
      {restoreMessage && (
        <p className="notice success" aria-hidden="true">
          {restoreMessage}
        </p>
      )}
      <StatusRegion label="MPC Autofill XML export status">
        {mpcExportStatus}
      </StatusRegion>
      {!metadata && (
        <StatusRegion label="Art policy status">{artStatus}</StatusRegion>
      )}
      <ErrorNotice error={task.error} />
      {view === "edit" && (
        <WorkspaceEditor
          deck={deck}
          onChange={setDeck}
          onArt={selectArt}
          onCommit={async (next) => {
            await commit(next);
            heading.current?.focus();
          }}
        />
      )}
      {view === "art" && selected && (
        <ArtPicker
          deck={deck}
          entry={selected}
          onSelect={setSelectedId}
          onApply={commit}
          canLocalize={!dirty && !isSaving && !artTask.busy}
          onLocalize={previewLocalization}
          canUseSet={!dirty && !isSaving && !artTask.busy}
          onUseSet={(set, opener) =>
            previewPolicy({ kind: "matchSet", set, family: true }, opener)
          }
          onEditionsLoading={onEditionsLoading}
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
          preservePreview={preserveStudioPreview}
        />
      )}
      {!metadata && !artPreview && <ErrorNotice error={artTask.error} />}
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
        <DeckSettings
          deck={deck}
          setDeck={setDeck}
          dirty={dirty}
          isSaving={isSaving}
          busy={task.busy}
          error={task.error}
          art={art}
          onClose={() => setMetadata(false)}
          onSave={() =>
            void task.run(async () => {
              await commit(deck);
              setMetadata(false);
            })
          }
        />
      )}
      {artPreview?.language ? (
        <DeckLanguagePreview
          deck={deck}
          language={artPreview.language}
          preview={artPreview.result}
          progress={artPreview.progress}
          busy={artTask.busy}
          error={artPreview.error}
          onKeep={keepArt}
          onApply={applyArt}
          onOverride={overrideLanguage}
        />
      ) : (
        artPreview && (
          <ArtPreviewDialog
            preview={artPreview.result}
            progress={artPreview.progress}
            busy={artTask.busy}
            error={artPreview.error}
            onKeep={keepArt}
            onApply={applyArt}
          />
        )
      )}
    </fieldset>
  );
}
