import { Check } from "lucide-react";
import type { ImportResult } from "./api.ts";
import { zones } from "./core/index.ts";
import { countCards, ErrorNotice, zoneNames } from "./ui.tsx";

const plural = (count: number) => `${count} ${count === 1 ? "card" : "cards"}`;

/** Card counts per board, in deck order, skipping empty boards. */
export function boardCounts(entries: ImportResult["entries"]) {
  return zones
    .map((zone) => ({
      zone,
      count: countCards(entries.filter((entry) => entry.zone === zone)),
    }))
    .filter((board) => board.count > 0);
}

/** What the Add or Replace action will do, in one sentence. */
export function saveScope(total: number, existing: number, replace: boolean) {
  if (!total)
    return "No cards resolved, so there is nothing to save. Correct the lines above and resolve again.";
  if (replace && existing)
    return `Replace removes the ${plural(existing)} in this deck and saves these ${plural(total)}, keeping art choices for matching cards.`;
  if (existing)
    return `Add saves these ${plural(total)} alongside the ${plural(existing)} already in this deck.`;
  return `Add saves these ${plural(total)} to this deck.`;
}

export function ImportReview({
  result,
  existing,
  replace,
  onReplace,
  showLines,
  saving,
  saved,
  saveError,
  onSave,
}: {
  result: ImportResult;
  existing: number;
  replace: boolean;
  onReplace: (replace: boolean) => void;
  showLines: boolean;
  saving: boolean;
  saved: number | null;
  saveError: unknown;
  onSave: () => void;
}) {
  const total = countCards(result.entries);
  const boards = boardCounts(result.entries);
  const locked = saving || saved !== null;
  return (
    <div className="import-result">
      <span className="badge official">{result.format}</span>
      <p>
        <Check size={16} />
        {plural(total)} resolved
      </p>
      {boards.length > 0 && (
        <ul className="import-boards" aria-label="Resolved cards by board">
          {boards.map((board) => (
            <li key={board.zone}>
              <span>{zoneNames[board.zone]}</span>
              <strong>{board.count}</strong>
            </li>
          ))}
        </ul>
      )}
      {result.issues.length > 0 && (
        <div className="import-issues">
          <strong>
            {result.issues.length}{" "}
            {result.issues.length === 1 ? "line needs" : "lines need"} review
          </strong>
          <ul aria-label="Unresolved lines">
            {result.issues.map((issue) => (
              <li key={`${issue.line}-${issue.input}-${issue.message}`}>
                {showLines && issue.line > 0 && (
                  <span className="import-line">Line {issue.line}</span>
                )}
                <code>{issue.input}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
          <p>
            Only resolved cards will be saved. Correct these lines and resolve
            again to include them.
          </p>
        </div>
      )}
      {saved === null && existing > 0 && total > 0 && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={replace}
            disabled={saving}
            onChange={(event) => onReplace(event.target.checked)}
          />
          Replace current list, keeping matching art choices
        </label>
      )}
      {saved === null && (
        <p className="hint">{saveScope(total, existing, replace)}</p>
      )}
      <ErrorNotice error={saveError} />
      <button
        type="button"
        className="primary wide"
        disabled={!total}
        aria-disabled={locked || undefined}
        onClick={() => {
          if (!locked) onSave();
        }}
      >
        {saved !== null
          ? "Imported and saved"
          : saving
            ? "Saving…"
            : replace && existing
              ? `Replace list with ${plural(total)}`
              : `Add ${plural(total)} to deck`}
      </button>
      <p className="import-status" role="status">
        {saved !== null && `Saved ${plural(saved)} to this deck.`}
      </p>
    </div>
  );
}
