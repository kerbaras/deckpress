import {
  ArrowLeft,
  Check,
  CircleAlert,
  Download,
  FileCode,
  Image,
  List,
  LoaderCircle,
  Printer,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import type { RefObject } from "react";
import { downloadJson, isWebPreview } from "./api.ts";
import { ArtPolicyFields } from "./art-policy.tsx";
import { type Deck, formatCount, formats } from "./core/index.ts";
import { PageToolbar } from "./titlebar.tsx";
import { countCards, ErrorNotice, Modal, StatusRegion } from "./ui.tsx";
import type { useWorkspaceArt } from "./use-workspace-art.ts";

export function BackButton({
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

export type WorkspaceView = (typeof views)[number]["id"];

export function WorkspaceToolbar({
  deck,
  view,
  setView,
  onBack,
  confirmArtExit,
  isSaving,
  dirty,
  busy,
  heading,
  saveButton,
  saveChanges,
  onExportMpc,
  onSettings,
}: {
  deck: Deck;
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  onBack: (trigger: HTMLButtonElement) => void;
  confirmArtExit: (trigger: HTMLButtonElement) => boolean | Promise<boolean>;
  isSaving: boolean;
  dirty: boolean;
  busy: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
  saveButton: RefObject<HTMLButtonElement | null>;
  saveChanges: () => void;
  onExportMpc: () => void;
  onSettings: () => void;
}) {
  const saveStatus = isSaving ? "Saving…" : dirty ? "Unsaved changes" : "Saved";
  const SaveStatusIcon = isSaving ? LoaderCircle : dirty ? CircleAlert : Check;
  return (
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
        <nav className="segmented workspace-views" aria-label="Deck workspace">
          {views.map(({ id, name, icon: Icon }) => (
            <button
              type="button"
              key={id}
              disabled={isSaving || (id !== "edit" && !deck.entries.length)}
              aria-current={view === id ? "page" : undefined}
              title={name}
              onClick={async (event) => {
                if (id !== view) {
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
        disabled={isSaving || busy || !dirty}
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
        title={
          isWebPreview()
            ? "MPC Autofill requires the desktop app"
            : "Export MPC Autofill XML"
        }
        disabled={isWebPreview() || busy || !deck.entries.length}
        onClick={onExportMpc}
      >
        <FileCode size={16} />
      </button>
      <button
        type="button"
        className="icon-button quiet"
        aria-label="Deck settings"
        title="Deck settings"
        disabled={isSaving}
        onClick={onSettings}
      >
        <SlidersHorizontal size={16} />
      </button>
    </PageToolbar>
  );
}

export function DeckSettings({
  deck,
  setDeck,
  supportsSetFamilies,
  dirty,
  isSaving,
  busy,
  error,
  art,
  onClose,
  onSave,
}: {
  deck: Deck;
  setDeck: (deck: Deck) => void;
  supportsSetFamilies: boolean;
  dirty: boolean;
  isSaving: boolean;
  busy: boolean;
  error: unknown;
  art: ReturnType<typeof useWorkspaceArt>;
  onClose: () => void;
  onSave: () => void;
}) {
  const {
    artTask,
    artPreview,
    artStatus,
    previewButton,
    canUndoArt,
    previewPolicy,
    undoArt,
  } = art;
  return (
    <Modal title="Deck settings" busy={busy || artTask.busy} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <label className="field">
          Deck name
          <input
            required
            maxLength={100}
            value={deck.name}
            onChange={(event) => setDeck({ ...deck, name: event.target.value })}
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
        <ArtPolicyFields
          key={JSON.stringify(deck.artPolicy)}
          deckId={deck.id}
          revision={deck.revision}
          supportsSetFamilies={supportsSetFamilies}
          current={deck.artPolicy}
          disabled={dirty || isSaving}
          busy={artTask.busy}
          previewButton={previewButton}
          canUndo={canUndoArt}
          onPreview={previewPolicy}
          onUndo={undoArt}
        />
        <StatusRegion label="Art policy status">{artStatus}</StatusRegion>
        {!artPreview && <ErrorNotice error={artTask.error} />}
        <ErrorNotice error={error} />
        <div className="modal-actions">
          <button
            type="submit"
            className="primary"
            disabled={busy || artTask.busy || !deck.name.trim()}
          >
            Save deck settings
          </button>
        </div>
      </form>
    </Modal>
  );
}
