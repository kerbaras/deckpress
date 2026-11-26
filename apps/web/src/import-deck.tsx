import { useId, useRef, useState } from "react";
import { api } from "./api.ts";
import { type Deck, formats } from "./core/index.ts";
import { ImportPanel } from "./import-panel.tsx";
import { Modal } from "./ui.tsx";

/** Name, format and list in one dialog; the deck is only created when the cards are added. */
export function ImportDeck({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (deck: Deck) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState<Deck["format"]>("Commander");
  const [nameError, setNameError] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const nameErrorId = useId();
  return (
    <Modal title="Import a list" wide onClose={onClose}>
      <div className="import-deck">
        <p className="muted">
          Nothing is saved until you add the cards. Cancel at any point to leave
          your library as it is.
        </p>
        <div className="import-deck-fields">
          <label className="field">
            Deck name
            <input
              ref={nameField}
              required
              maxLength={100}
              placeholder="Your next favorite deck"
              value={name}
              aria-invalid={nameError || undefined}
              aria-describedby={nameError ? nameErrorId : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(false);
              }}
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
        </div>
        {nameError && (
          <p id={nameErrorId} className="field-error" role="alert">
            Name the deck before adding the cards.
          </p>
        )}
        <ImportPanel
          existing={0}
          beforeApply={() => {
            if (name.trim()) return true;
            setNameError(true);
            nameField.current?.focus();
            return false;
          }}
          onApply={async (result) => {
            const trimmed = name.trim();
            await onSaved(
              await api.createDeck({
                name: trimmed,
                format,
                entries: result.entries,
              }),
            );
          }}
        />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
