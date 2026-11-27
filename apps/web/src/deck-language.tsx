import { useState } from "react";
import type { ArtPreview, LanguageTier } from "./api.ts";
import { PrintSummary } from "./art-policy.tsx";
import type { Deck, DeckEntry } from "./core/index.ts";
import { languageList, printLanguages } from "./print-language.tsx";
import { useScryfallPrints } from "./scryfall-editions.ts";
import { ErrorNotice, Modal, StatusRegion, useTask } from "./ui.tsx";

export const deckLanguageUnavailable =
  "Deck language switching is not available on the web yet.";

export function DeckLanguageControl({
  language,
  disabled,
  web,
  onSelect,
  onUndo,
}: {
  language: string | undefined;
  disabled: boolean;
  web: boolean;
  onSelect: (language: string, opener: HTMLSelectElement) => void;
  onUndo: (() => void) | undefined;
}) {
  const [showAvailability, setShowAvailability] = useState(false);
  return (
    <div className="deck-language-control">
      {web ? (
        <button
          type="button"
          className="quiet"
          onClick={() => setShowAvailability(true)}
        >
          Deck language
        </button>
      ) : (
        <label className="inline-label">
          Deck language
          <select
            value={language ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onSelect(event.currentTarget.value, event.currentTarget)
            }
          >
            <option value="" disabled>
              Import default
            </option>
            {printLanguages.map(([code, name]) => (
              <option value={code} key={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {onUndo && (
        <button
          type="button"
          className="quiet"
          disabled={disabled}
          onClick={onUndo}
        >
          Undo language change
        </button>
      )}
      {showAvailability && (
        <Modal title="Deck language" onClose={() => setShowAvailability(false)}>
          <p>{deckLanguageUnavailable}</p>
        </Modal>
      )}
    </div>
  );
}

const tierLabels = {
  samePrinting: "Same printing",
  sameSet: "Same set or family",
  sameArt: "Same art",
  closest: "Closest style",
  keptEnglish: "Kept English",
  keptCurrent: "Kept current",
  pinned: "Pinned",
  override: "Manual override",
} satisfies Record<LanguageTier, string>;

export function DeckLanguagePreview({
  deck,
  language,
  preview,
  error,
  busy,
  onKeep,
  onApply,
  onOverride,
}: {
  deck: Deck;
  language: string;
  preview: ArtPreview | undefined;
  error: unknown;
  busy: boolean;
  onKeep: () => void;
  onApply: () => void;
  onOverride: (entryId: string, artId: string) => Promise<void>;
}) {
  const [override, setOverride] = useState<DeckEntry>();
  const counts = new Map<LanguageTier, number>();
  for (const { tier, quantity } of preview?.changes ?? []) {
    if (tier) counts.set(tier, (counts.get(tier) ?? 0) + quantity);
  }
  const review = preview?.changes.filter(
    ({ tier }) => tier && tier !== "samePrinting",
  );
  const target = languageList([language]);
  return (
    <>
      <Modal
        title={`Preview deck language · ${target}`}
        wide
        busy={busy}
        onClose={onKeep}
      >
        <StatusRegion className="hint" label="Language preview status">
          {!preview && !error && "Finding matching printings on Scryfall…"}
          {preview &&
            `${target} preview ready. ${review?.length ?? 0} rows to review.`}
        </StatusRegion>
        {preview && (
          <ul
            className="language-preview-summary"
            aria-label="Printing match counts"
          >
            {Object.entries(tierLabels).map(([tier, label]) => {
              const count = counts.get(tier as LanguageTier) ?? 0;
              return (
                count > 0 && (
                  <li className="badge" key={tier}>
                    <strong>{count}</strong> {label}
                  </li>
                )
              );
            })}
          </ul>
        )}
        {!!review?.length && (
          <ul className="art-change-list" aria-label="Printings to review">
            {review.map((row) => (
              <li key={row.entryId}>
                <div className="section-heading">
                  <strong>
                    {row.quantity}× {row.name}
                  </strong>
                  {row.tier !== "pinned" && (
                    <button
                      type="button"
                      className="quiet"
                      disabled={busy}
                      aria-label={`Choose another printing for ${row.name}`}
                      onClick={() =>
                        setOverride(
                          deck.entries.find(
                            (entry) => entry.id === row.entryId,
                          ),
                        )
                      }
                    >
                      Choose another printing
                    </button>
                  )}
                </div>
                {row.tier && (
                  <p>
                    <span className="badge">{tierLabels[row.tier]}</span>{" "}
                    {row.reason}
                  </p>
                )}
                <div className="art-change-prints">
                  <PrintSummary
                    art={row.before}
                    back={row.beforeBack}
                    label="Current"
                  />
                  {row.after && (
                    <PrintSummary
                      art={row.after}
                      back={row.afterBack}
                      label="Proposed"
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <ErrorNotice error={error} />
        <div className="modal-actions">
          <button type="button" onClick={onKeep} disabled={busy}>
            Keep current language
          </button>
          <button
            type="button"
            className="primary"
            onClick={onApply}
            disabled={busy || !preview?.canApply}
          >
            Apply {target}
          </button>
        </div>
      </Modal>
      {override && (
        <LanguageArtPicker
          entry={override}
          language={language}
          onClose={() => setOverride(undefined)}
          onChoose={async (artId) => {
            await onOverride(override.id, artId);
            setOverride(undefined);
          }}
        />
      )}
    </>
  );
}

function LanguageArtPicker({
  entry,
  language,
  onChoose,
  onClose,
}: {
  entry: DeckEntry;
  language: string;
  onChoose: (artId: string) => Promise<void>;
  onClose: () => void;
}) {
  const prints = useScryfallPrints(entry.card, 0, language);
  const task = useTask();
  const editions = prints.data?.pages.flatMap(({ items }) =>
    items.filter(
      (art) =>
        art.language === language &&
        (entry.card.faces.length === 1 || art.backImageUrl),
    ),
  );
  return (
    <Modal
      title={`${languageList([language])} art picker · ${entry.card.name}`}
      onClose={onClose}
      busy={task.busy}
    >
      <StatusRegion label="Printing lookup status">
        {prints.isPending && "Finding Scryfall printings…"}
        {editions?.length === 0 &&
          !prints.hasNextPage &&
          "No usable printings in this language."}
      </StatusRegion>
      <ErrorNotice error={prints.error ?? task.error} />
      {!!editions?.length && (
        <ul className="art-change-list" aria-label="Available printings">
          {editions.map((art) => (
            <li className="section-heading" key={art.id}>
              <PrintSummary art={art} label={art.source} />
              <button
                type="button"
                aria-label={`Use ${art.set.toUpperCase()} #${art.collectorNumber}`}
                disabled={task.busy}
                onClick={() => void task.run(() => onChoose(art.id))}
              >
                Use printing
              </button>
            </li>
          ))}
        </ul>
      )}
      {prints.hasNextPage && (
        <button
          type="button"
          disabled={prints.isFetching}
          onClick={() => void prints.fetchNextPage()}
        >
          Load more Scryfall prints
        </button>
      )}
    </Modal>
  );
}
