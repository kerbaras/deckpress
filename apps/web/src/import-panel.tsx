import {
  AlertCircle,
  ClipboardPaste,
  FileUp,
  ListPlus,
  RotateCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ImportResult, UrlImportError } from "./api.ts";
import { isMpcXml } from "./core/index.ts";
import { ImportReview, importStatus } from "./import-review.tsx";
import { countCards, ErrorNotice, useTask } from "./ui.tsx";

type Mode = "paste" | "file" | "url";
const modes: Mode[] = ["paste", "file", "url"];
const modeLabels = { paste: "Paste", file: "File", url: "URL" };

export function ImportPanel({
  existing,
  onApply,
  beforeApply,
}: {
  existing: number;
  onApply: (result: ImportResult, replace: boolean) => Promise<void>;
  /** Returns false to stop a save before it starts, e.g. while a host form is incomplete. */
  beforeApply?: () => boolean;
}) {
  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [resolvedMode, setResolvedMode] = useState<Mode>("paste");
  const [replace, setReplace] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);
  const [urlError, setUrlError] = useState<{
    message: string;
    fromRetry: boolean;
  } | null>(null);
  const [focusPaste, setFocusPaste] = useState(false);
  const decklist = useRef<HTMLTextAreaElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const task = useTask();
  const save = useTask();
  const busy = task.busy || save.busy;
  const mpc = mode !== "url" && isMpcXml(text);
  const reset = () => {
    setResult(null);
    setSaved(null);
    setUrlError(null);
  };
  const switchMode = (next: Mode) => {
    setMode(next);
    reset();
  };
  useEffect(() => {
    if (!focusPaste || mode !== "paste") return;
    decklist.current?.focus();
    setFocusPaste(false);
  }, [focusPaste, mode]);
  useEffect(() => {
    if (!urlError || busy) return;
    if (urlError.fromRetry) urlInput.current?.focus();
    else retry.current?.focus();
  }, [urlError, busy]);
  const resolve = (source: "resolve" | "retry") =>
    void task.run(async () => {
      reset();
      try {
        setResult(
          await api.import(mode === "url" ? { url: url.trim() } : { text }),
        );
        setResolvedMode(mode);
      } catch (error) {
        if (!(error instanceof UrlImportError)) throw error;
        setUrlError({ message: error.message, fromRetry: source === "retry" });
      }
    });
  return (
    <section className="panel import-panel">
      <div className="section-heading">
        <h3>
          <ListPlus className="size-icon stroke-icon" />
          Import cards
        </h3>
        <span className="badge">Auto-detect</span>
      </div>
      <div className="segmented">
        {modes.map((value) => (
          <button
            type="button"
            key={value}
            disabled={busy}
            aria-pressed={mode === value}
            onClick={() => switchMode(value)}
          >
            {modeLabels[value]}
          </button>
        ))}
      </div>
      <fieldset disabled={busy}>
        {mode === "url" ? (
          <>
            <label className="field">
              Public deck URL
              <input
                ref={urlInput}
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
              Public Archidekt decks import directly. Moxfield may block apps
              outside the browser. If it does, use More › Download / Export ›
              Copy Plain Text there and paste the list instead.
            </p>
          </>
        ) : (
          <>
            {mode === "file" && (
              <label className="file-drop">
                <FileUp size={22} />
                <strong>Choose a decklist</strong>
                <span>
                  TXT, CSV, Arena export, MTGO .dek or MPC Autofill XML
                </span>
                <input
                  type="file"
                  accept=".txt,.csv,.dek,.xml"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file)
                      void task.run(async () => {
                        if (/\.xml$/i.test(file.name)) {
                          if (file.size > 512 * 1024)
                            throw new Error("XML decklist exceeds 512 KB");
                        } else if (file.size > 200_000)
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
                ref={decklist}
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
              Plain text, Arena, CSV, named MTGO XML and MPC Autofill XML. Set
              codes and collector numbers keep the exact printing.
            </p>
          </>
        )}
        <button
          type="button"
          className="wide"
          disabled={mode === "url" ? !url.trim() : !text.trim()}
          onClick={() => resolve("resolve")}
        >
          {task.busy
            ? mpc
              ? "Reading MPC Autofill order…"
              : "Resolving cards…"
            : mpc
              ? "Read MPC Autofill order"
              : "Resolve on Scryfall"}
        </button>
      </fieldset>
      <ErrorNotice error={task.error} />
      {urlError && mode === "url" && (
        <div className="notice error import-url-error" role="alert">
          <AlertCircle className="size-icon shrink-0 stroke-icon" />
          <span>{urlError.message}</span>
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                switchMode("paste");
                setFocusPaste(true);
              }}
            >
              <ClipboardPaste size={15} />
              Paste exported list
            </button>
            <button
              ref={retry}
              type="button"
              disabled={busy}
              onClick={() => resolve("retry")}
            >
              <RotateCw size={15} />
              Retry URL
            </button>
          </div>
        </div>
      )}
      {result && (
        <ImportReview
          result={result}
          existing={existing}
          replace={replace}
          onReplace={(value) => {
            setReplace(value);
            setSaved(null);
          }}
          showLines={resolvedMode !== "url"}
          saving={save.busy}
          saved={saved}
          saveError={save.error}
          onSave={() => {
            if (beforeApply && !beforeApply()) return;
            void save.run(async () => {
              await onApply(result, replace);
              setSaved(countCards(result.entries));
            });
          }}
        />
      )}
      <p className="import-status text-meta text-muted" role="status">
        {saved === null && result ? (
          <span className="sr-only">{importStatus(result, saved)}</span>
        ) : (
          importStatus(result, saved)
        )}
      </p>
    </section>
  );
}
