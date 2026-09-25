import { Check, FileUp, ListPlus } from "lucide-react";
import { useState } from "react";
import { api, type ImportResult } from "./api.ts";
import { countCards, ErrorNotice, useTask } from "./ui.tsx";

export function ImportPanel({
  existing,
  onApply,
}: {
  existing: number;
  onApply: (result: ImportResult, replace: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState("paste");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [replace, setReplace] = useState(false);
  const [applied, setApplied] = useState(false);
  const task = useTask();
  const reset = () => {
    setResult(null);
    setApplied(false);
  };
  return (
    <section className="panel import-panel">
      <div className="section-heading">
        <h3>
          <ListPlus size={17} />
          Import cards
        </h3>
        <span className="badge">Auto-detect</span>
      </div>
      <div className="segmented">
        {["paste", "file", "url"].map((value) => (
          <button
            type="button"
            key={value}
            disabled={task.busy}
            aria-pressed={mode === value}
            onClick={() => {
              setMode(value);
              reset();
            }}
          >
            {value === "url" ? "URL" : value === "file" ? "File" : "Paste"}
          </button>
        ))}
      </div>
      <fieldset disabled={task.busy}>
        {mode === "url" ? (
          <>
            <label className="field">
              Public deck URL
              <input
                type="url"
                placeholder="Moxfield or Archidekt link"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  reset();
                }}
              />
            </label>
            <p className="hint">
              If the source blocks imports, export a text list from the site and
              paste it here.
            </p>
          </>
        ) : (
          <>
            {mode === "file" && (
              <label className="file-drop">
                <FileUp size={22} />
                <strong>Choose a decklist</strong>
                <span>TXT, CSV, Arena export or MTGO .dek</span>
                <input
                  type="file"
                  accept=".txt,.csv,.dek,.xml"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file)
                      void task.run(async () => {
                        if (file.size > 200_000)
                          throw new Error("Decklist exceeds 200 KB");
                        setText(await file.text());
                        reset();
                      });
                    event.target.value = "";
                  }}
                />
              </label>
            )}
            <label className="field">
              Decklist
              <textarea
                className="decklist-input"
                spellCheck={false}
                placeholder={
                  "Deck\n4 Lightning Bolt (M10) 146\n1x Sol Ring\n8 Mountain\n\nSideboard\n2 Negate"
                }
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  reset();
                }}
              />
            </label>
            <p className="hint">
              Plain text, Arena, CSV and named MTGO XML. Set codes and collector
              numbers keep the exact printing.
            </p>
          </>
        )}
        <button
          type="button"
          className="wide"
          disabled={mode === "url" ? !url.trim() : !text.trim()}
          onClick={() =>
            void task.run(async () => {
              reset();
              setResult(
                await api.import(
                  mode === "url" ? { url: url.trim() } : { text },
                ),
              );
            })
          }
        >
          {task.busy ? "Resolving cards…" : "Resolve on Scryfall"}
        </button>
      </fieldset>
      <ErrorNotice error={task.error} />
      {result && (
        <div className="import-result">
          <span className="badge official">{result.format}</span>
          <p>
            <Check size={16} />
            {countCards(result.entries)} cards resolved
          </p>
          {result.issues.length > 0 && (
            <div className="import-issues">
              <strong>
                {result.issues.length}{" "}
                {result.issues.length === 1 ? "line needs" : "lines need"}{" "}
                review
              </strong>
              {result.issues.map((issue) => (
                <div key={`${issue.line}-${issue.input}-${issue.message}`}>
                  <code>{issue.input}</code>
                  <span>{issue.message}</span>
                </div>
              ))}
              <p>
                Only resolved cards will be imported. Correct these lines and
                resolve again to include them.
              </p>
            </div>
          )}
          {existing > 0 && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={replace}
                onChange={(event) => {
                  setReplace(event.target.checked);
                  setApplied(false);
                }}
              />
              Replace current list, keeping matching art choices
            </label>
          )}
          <button
            type="button"
            className="primary wide"
            disabled={task.busy || !result.entries.length || applied}
            onClick={() =>
              void task.run(async () => {
                await onApply(result, replace);
                setApplied(true);
              })
            }
          >
            {applied
              ? "Imported and saved"
              : replace
                ? `Replace list with ${countCards(result.entries)} cards`
                : `Add ${countCards(result.entries)} cards to deck`}
          </button>
        </div>
      )}
    </section>
  );
}
