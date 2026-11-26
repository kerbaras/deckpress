import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { api, type PrintLanguagePreferences } from "./api.ts";
import {
  type Art,
  backArt,
  type Deck,
  type DeckEntry,
  frontArt,
} from "./core/index.ts";
import { ErrorNotice, useTask } from "./ui.tsx";

export const printLanguages = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["ru", "Russian"],
  ["zhs", "Simplified Chinese"],
  ["zht", "Traditional Chinese"],
  ["he", "Hebrew"],
  ["la", "Latin"],
  ["grc", "Ancient Greek"],
  ["ar", "Arabic"],
  ["sa", "Sanskrit"],
  ["ph", "Phyrexian"],
  ["qya", "Quenya"],
  ["tlh", "Klingon"],
  ["dw", "Dwarvish"],
] as const;

const defaultPreferences: PrintLanguagePreferences = {
  languages: ["en"],
  policy: "fallback-to-english",
};
const languageNames = new Map<string, string>(printLanguages);
export const languageCode = (code: string) => code.toUpperCase() || "Unknown";
export const languageList = (codes: string[]) =>
  codes
    .map((code) => languageNames.get(code) ?? languageCode(code))
    .join(" / ");

export function PrintLanguageSettings({
  saved = defaultPreferences,
}: {
  saved: PrintLanguagePreferences | undefined;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(saved);
  const task = useTask();
  const save = () =>
    void task.run(async () => {
      const printLanguage = await api.savePrintLanguage(draft);
      client.setQueryData<Awaited<ReturnType<typeof api.settings>>>(
        ["settings"],
        (current) => current && { ...current, printLanguage },
      );
    });

  return (
    <section className="panel settings-card">
      <h2>Print languages</h2>
      <p>
        New imports try these languages from top to bottom. Changing this list
        does not change existing cards.
      </p>
      <fieldset disabled={task.busy}>
        {draft.languages.map((code, index) => (
          <div className="toolbar" key={code}>
            <label className="inline-label">
              {index === 0 ? "First choice" : `Choice ${index + 1}`}
              <select
                value={code}
                onChange={(event) => {
                  const next = event.target.value;
                  setDraft({
                    ...draft,
                    languages: draft.languages.map((language, i) =>
                      i === index ? next : language,
                    ),
                  });
                }}
              >
                {printLanguages
                  .filter(
                    ([value]) =>
                      value === code || !draft.languages.includes(value),
                  )
                  .map(([value, name]) => (
                    <option value={value} key={value}>
                      {name} ({value})
                    </option>
                  ))}
              </select>
            </label>
            {draft.languages.length > 1 && (
              <button
                type="button"
                aria-label={`Remove ${languageList([code])}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    languages: draft.languages.filter(
                      (language) => language !== code,
                    ),
                  })
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {draft.languages.length < printLanguages.length && (
          <label className="inline-label">
            Add a language
            <select
              value=""
              onChange={(event) =>
                setDraft({
                  ...draft,
                  languages: [...draft.languages, event.target.value],
                })
              }
            >
              <option value="" disabled>
                Choose a language
              </option>
              {printLanguages
                .filter(([value]) => !draft.languages.includes(value))
                .map(([value, name]) => (
                  <option value={value} key={value}>
                    {name} ({value})
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          If none are available
          <select
            value={draft.policy}
            onChange={(event) =>
              setDraft({
                ...draft,
                policy:
                  event.target.value === "strict"
                    ? "strict"
                    : "fallback-to-english",
              })
            }
          >
            <option value="strict">
              Strict: list missing cards without importing them
            </option>
            <option value="fallback-to-english">
              Use English and mark each fallback
            </option>
          </select>
        </label>
      </fieldset>
      <ErrorNotice error={task.error} />
      <button
        type="button"
        disabled={
          task.busy ||
          (draft.policy === saved.policy &&
            draft.languages.join(",") === saved.languages.join(","))
        }
        onClick={save}
      >
        Save print languages
      </button>
    </section>
  );
}

export function isEnglishFallback(entry: DeckEntry, art = frontArt(entry)) {
  const requested = entry.requestedLanguages;
  return Boolean(
    requested?.length &&
      !requested.includes("en") &&
      art.language === "en" &&
      (art.englishFallback ||
        [entry.card.faces, entry.policyArt ?? []].some((faces) =>
          faces.some(
            (face) =>
              face.id === art.id ||
              (face.backImageUrl && `${face.id}:back` === art.id),
          ),
        )),
  );
}

export function languageBadge(entry: DeckEntry, art: Art) {
  if (isEnglishFallback(entry, art)) return "English fallback";
  const requested = entry.requestedLanguages;
  const code = languageCode(art.language);
  return requested?.length && !requested.includes(art.language)
    ? `${code} · not preferred`
    : code;
}

export function entryLanguageLabel(entry: DeckEntry) {
  const front = frontArt(entry);
  const label = languageBadge(entry, front);
  const back = backArt(entry);
  const backLabel = back && languageBadge(entry, back);
  return backLabel && backLabel !== label
    ? `${label} / ${backLabel} back`
    : label;
}

export function DeckLanguageSummary({ deck }: { deck: Deck }) {
  const missing = new Map<
    string,
    { skipped: Set<string>; fallbacks: Set<string> }
  >();
  const group = (langs: string[]) => {
    const label = languageList(langs);
    const set = missing.get(label) ?? {
      skipped: new Set<string>(),
      fallbacks: new Set<string>(),
    };
    missing.set(label, set);
    return set;
  };
  for (const item of deck.missingPrints ?? [])
    group(item.languages).skipped.add(item.input);
  for (const entry of deck.entries) {
    const back = backArt(entry);
    if (
      entry.requestedLanguages &&
      (isEnglishFallback(entry) || (back && isEnglishFallback(entry, back)))
    ) {
      group(entry.requestedLanguages).fallbacks.add(entry.card.name);
    }
  }
  return [...missing].map(([languages, { skipped, fallbacks }]) => (
    <section
      className="notice warning"
      aria-label={`Missing in ${languages}`}
      key={languages}
    >
      <AlertTriangle size={16} aria-hidden />
      <div>
        <strong>Missing in {languages}</strong>
        {skipped.size > 0 && (
          <div>Not imported (last import): {[...skipped].join(", ")}</div>
        )}
        {fallbacks.size > 0 && (
          <div>English fallback: {[...fallbacks].join(", ")}</div>
        )}
      </div>
    </section>
  ));
}
