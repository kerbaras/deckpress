import { type DeckEntry, formatCount } from "./core/index.ts";
import { orderEntries } from "./deck-builder-model.ts";
import { countCards, Modal } from "./ui.tsx";

/** Confirms a wizard change that would remove cards already picked. */
export function DroppedPicksDialog({
  reason,
  dropped,
  onKeep,
  onApply,
}: {
  reason: string;
  dropped: DeckEntry[];
  onKeep: () => void;
  onApply: () => void;
}) {
  const count = countCards(dropped);
  return (
    <Modal title="Remove picked cards?" onClose={onKeep}>
      <p>
        {reason} Applying it removes {formatCount(count, "card")} from the
        draft:
      </p>
      <ul className="builder-deck builder-dropped" aria-label="Cards removed">
        {orderEntries(dropped).map((entry) => (
          <li key={entry.id}>
            <span className="builder-deck-name">
              <span className="mono">{entry.quantity}×</span>
              <span className="builder-deck-title">{entry.card.name}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <button type="button" className="primary" onClick={onKeep}>
          Keep current choices
        </button>
        <button type="button" className="danger" onClick={onApply}>
          Apply change
        </button>
      </div>
    </Modal>
  );
}
