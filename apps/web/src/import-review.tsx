import { Check } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ImportResult } from "./api.ts";
import { frontArt, mpcXmlFormat, zones } from "./core/index.ts";
import { isEnglishFallback, languageList } from "./print-language.tsx";
import { countCards, ErrorNotice, zoneNames } from "./ui.tsx";

const plural = (count: number) => `${count} ${count === 1 ? "card" : "cards"}`;
const printingLabel = (set: string, collectorNumber: string) =>
  [set.toUpperCase(), collectorNumber && `#${collectorNumber}`]
    .filter(Boolean)
    .join(" ");

export function ImportIssueDetails({
  issue: { kind, message, printLookup },
}: {
  issue: ImportResult["issues"][number];
}) {
  if (kind !== "noUsableScan" || !printLookup) return <span>{message}</span>;
  const languages = languageList(printLookup.languages);
  return (
    <>
      <code>
        Looked up: {printingLabel(printLookup.set, printLookup.collectorNumber)}{" "}
        ({printLookup.languages.join(" / ")})
      </code>
      <span>
        {printLookup.languages.length === 1
          ? `No usable ${languages} scan.`
          : `No usable scan in ${languages}.`}
      </span>
    </>
  );
}

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
export function saveScope(
  total: number,
  existing: number,
  replace: boolean,
  mpc = false,
) {
  if (!total)
    return "No cards resolved, so there is nothing to save. Correct the lines above and resolve again.";
  if (replace && existing)
    return `Replace removes the ${plural(existing)} in this deck and saves these ${plural(total)}${mpc ? " with the MPC Autofill artwork." : ", keeping art choices for matching cards."}`;
  if (existing)
    return `Add saves these ${plural(total)} alongside the ${plural(existing)} already in this deck.`;
  return `Add saves these ${plural(total)} to this deck.`;
}

export function importLanguageSummary({
  entries,
  missingPrints,
}: Pick<ImportResult, "entries" | "missingPrints">) {
  const skipped = missingPrints?.length ?? 0;
  const fallbacks = countCards(
    entries.filter((entry) => isEnglishFallback(entry)),
  );
  return [
    skipped > 0
      ? `No usable scan for ${skipped} ${skipped === 1 ? "printing" : "printings"}.`
      : "",
    fallbacks > 0
      ? `${plural(fallbacks)} ${fallbacks === 1 ? "uses" : "use"} English fallback.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Live-region text announcing a resolve result. */
export function resolveSummary(result: ImportResult) {
  const issues = result.issues.length;
  const review = issues
    ? `${issues} ${issues === 1 ? "line needs" : "lines need"} review.`
    : "No lines need review.";
  return [
    `${plural(countCards(result.entries))} resolved. ${review}`,
    importLanguageSummary(result),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Live-region text for the latest import step. */
export function importStatus(
  result: ImportResult | null,
  saved: number | null,
) {
  if (saved !== null) return `Saved ${plural(saved)} to this deck.`;
  return result ? resolveSummary(result) : "";
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
  const fallbacks = result.entries.flatMap((entry) => {
    const art = frontArt(entry);
    if (!entry.requestedLanguages?.length || !isEnglishFallback(entry, art))
      return [];
    const printing = printingLabel(art.set, art.collectorNumber);
    return [
      {
        id: entry.id,
        label: `${entry.card.name}${printing ? ` — ${printing}` : ""} (${entry.requestedLanguages.join(" / ")} → ${art.language})`,
      },
    ];
  });
  const locked = saving || saved !== null;
  const mpc = result.format === mpcXmlFormat;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div className="import-result">
      <span className="badge official">{result.format}</span>
      <h4 ref={heading} className="import-summary" tabIndex={-1}>
        <Check className="size-icon stroke-icon" />
        {plural(total)} resolved
      </h4>
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
      {fallbacks.length > 0 && (
        <div className="import-issues">
          <strong>English fallback</strong>
          <ul aria-label="English fallbacks">
            {fallbacks.map(({ id, label }) => (
              <li key={id}>
                <code>{label}</code>
              </li>
            ))}
          </ul>
        </div>
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
                <ImportIssueDetails issue={issue} />
              </li>
            ))}
          </ul>
          <p>
            Only resolved cards will be saved.{" "}
            {result.missingPrints?.length
              ? "Correct the lines or change your print language settings, then resolve again."
              : "Correct these lines and resolve again to include them."}
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
          {mpc
            ? "Replace current list with the MPC Autofill order"
            : "Replace current list, keeping matching art choices"}
        </label>
      )}
      {saved === null && (
        <p className="hint">{saveScope(total, existing, replace, mpc)}</p>
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
    </div>
  );
}
