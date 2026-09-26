import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ScoredArt, type StyleReport } from "./api.ts";
import { type Art, type Deck, type DeckEntry, frontArt } from "./core/index.ts";
import { CardImage, ErrorNotice, Modal, useTask } from "./ui.tsx";

/** Printings compared per card; matches the limit enforced in Rust. */
const MAX_OPTIONS = 80;
/** Alternatives offered per card in the review table. */
const SHOWN = 3;

type Phase =
  | { step: "intro" }
  | { step: "collect"; done: number; total: number }
  | { step: "analyse"; done: number; total: number }
  | { step: "review"; report: StyleReport };

/** Every candidate printing for a card: what it uses now plus its Scryfall
 * editions. Community art is left out on purpose: its metadata is too thin
 * to rank fairly and every image would have to be fetched from Drive. */
export async function collectOptions(entry: DeckEntry): Promise<Art[]> {
  const items = [entry.card.faces[0], entry.selectedArt].filter(
    (art): art is Art => !!art,
  );
  let page = 1;
  while (items.length < MAX_OPTIONS) {
    const result = await api.art(
      "scryfall",
      entry.card.oracleId,
      entry.card.name,
      0,
      page,
    );
    items.push(...result.items);
    if (!result.hasMore) break;
    page += 1;
  }
  return [...new Map(items.map((art) => [art.id, art])).values()].slice(
    0,
    MAX_OPTIONS,
  );
}

/** Cache key for a card's candidates. The chosen printing is one of the
 * candidates, so swapping it must miss the cache. */
export function optionsKey(entry: DeckEntry) {
  return [
    "style-options",
    entry.card.oracleId,
    entry.card.faces[0]?.id ?? "",
    entry.selectedArt?.id ?? "",
  ];
}

export function targetsFor(deck: Deck, entry: DeckEntry): DeckEntry[] {
  return deck.entries.filter(
    (item) => item.card.oracleId !== entry.card.oracleId,
  );
}

/** Deck with each chosen printing applied. A pick equal to the original
 * printing clears the override instead of storing a copy of it. */
export function applyPicks(
  deck: Deck,
  picks: Record<string, Art | undefined>,
): Deck {
  return {
    ...deck,
    entries: deck.entries.map((entry) => {
      const pick = picks[entry.id];
      if (!pick) return entry;
      return {
        ...entry,
        selectedArt: pick.id === entry.card.faces[0]?.id ? null : pick,
      };
    }),
  };
}

export function StyleMatch({
  deck,
  entry,
  reference,
  onClose,
  onApply,
}: {
  deck: Deck;
  entry: DeckEntry;
  reference: Art;
  onClose: () => void;
  onApply: (deck: Deck) => Promise<Deck>;
}) {
  const client = useQueryClient();
  const task = useTask();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.settings(signal),
  });
  const modelReady = settings.data?.styleModel?.installed ?? false;
  const [useModel, setUseModel] = useState(true);
  const [phase, setPhase] = useState<Phase>({ step: "intro" });
  const [picks, setPicks] = useState<Record<string, Art | undefined>>({});
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const targets = targetsFor(deck, entry);

  const run = () =>
    void task.run(async () => {
      try {
        setPhase({ step: "collect", done: 0, total: targets.length });
        const entries: { entryId: string; options: Art[] }[] = [];
        for (const [index, target] of targets.entries()) {
          const options = await client.fetchQuery({
            queryKey: optionsKey(target),
            queryFn: () => collectOptions(target),
            staleTime: 86_400_000,
          });
          entries.push({ entryId: target.id, options });
          if (!open.current) return;
          setPhase({
            step: "collect",
            done: index + 1,
            total: targets.length,
          });
        }
        setPhase({ step: "analyse", done: 0, total: 0 });
        const report = await api.matchArtStyle(
          { reference, entries, useModel: useModel && modelReady },
          (progress) => {
            if (open.current) setPhase({ step: "analyse", ...progress });
          },
        );
        if (!open.current) return;
        const next: Record<string, Art | undefined> = {};
        for (const match of report.matches) {
          const current = targets.find((item) => item.id === match.entryId);
          const best = match.ranked[0]?.art;
          if (current && best && best.id !== frontArt(current).id)
            next[match.entryId] = best;
        }
        setPicks(next);
        setPhase({ step: "review", report });
      } catch (cause) {
        if (open.current) setPhase({ step: "intro" });
        throw cause;
      }
    });

  const changes = Object.values(picks).filter(Boolean).length;
  const apply = () =>
    void task.run(async () => {
      await onApply(applyPicks(deck, picks));
      onClose();
    });

  return (
    <Modal
      title="Match art style"
      wide
      busy={task.busy && phase.step === "review"}
      onClose={onClose}
    >
      <div className="style-match">
        <div className="style-reference">
          <CardImage url={reference.thumbnailUrl} name={reference.name} />
          <div>
            <span className="badge">Beta</span>
            <h3>{reference.name}</h3>
            <p className="muted">
              {reference.artist}
              {reference.source ? ` · ${reference.source}` : ""}
            </p>
            <p className="hint">
              Ranks every Scryfall printing of the other {targets.length} cards
              by how closely its illustration resembles this one, then lets you
              review each pick before anything changes.
            </p>
          </div>
        </div>
        <ErrorNotice error={task.error} />
        {phase.step === "intro" && (
          <>
            <label className="check-label">
              <input
                type="checkbox"
                className="style-model-toggle"
                checked={useModel && modelReady}
                disabled={!modelReady}
                onChange={(event) => setUseModel(event.target.checked)}
              />
              <span>
                Compare illustrations with the on-device image model
                <small className="style-option-hint">
                  {modelReady
                    ? "Palette and texture statistics from a small CNN, blended 70/30 with artist, frame labels, set and era."
                    : "The art-style model is not installed in this build; only artist, labels, set and era are compared."}
                </small>
              </span>
            </label>
            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!targets.length || task.busy}
                onClick={run}
              >
                <Sparkles size={15} />
                {task.error ? "Try again" : "Find matches"}
              </button>
            </div>
          </>
        )}
        {(phase.step === "collect" || phase.step === "analyse") && (
          <div className="style-progress" role="status">
            <LoaderCircle size={17} className="spin" />
            <div>
              <strong>
                {phase.step === "collect"
                  ? "Collecting printings"
                  : "Comparing illustrations"}
              </strong>
              <span className="mono muted">
                {phase.total
                  ? `${phase.done} / ${phase.total}`
                  : "Loading model…"}
              </span>
            </div>
            <progress
              value={phase.total ? phase.done : undefined}
              max={phase.total || undefined}
            />
          </div>
        )}
        {phase.step === "review" && (
          <Review
            report={phase.report}
            targets={targets}
            picks={picks}
            onPick={(entryId, art) =>
              setPicks((current) => ({ ...current, [entryId]: art }))
            }
          />
        )}
        {phase.step === "review" && (
          <div className="modal-actions">
            <span className="muted">
              {changes
                ? `${changes} of ${targets.length} cards will change`
                : "No changes selected"}
            </span>
            <div className="spacer" />
            <button type="button" disabled={task.busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!changes || task.busy}
              onClick={apply}
            >
              {task.busy ? "Saving…" : `Apply ${changes || ""} changes`}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Review({
  report,
  targets,
  picks,
  onPick,
}: {
  report: StyleReport;
  targets: DeckEntry[];
  picks: Record<string, Art | undefined>;
  onPick: (entryId: string, art: Art | undefined) => void;
}) {
  return (
    <>
      <div className="style-summary">
        <span
          className={report.method === "model" ? "badge official" : "badge"}
        >
          {report.method === "model"
            ? `Image model · ${report.model?.executionProvider ?? "CPU"}`
            : "Metadata only"}
        </span>
        <span className="muted">
          {report.method === "model"
            ? `${report.embedded} illustrations compared${
                report.skipped ? `, ${report.skipped} skipped` : ""
              }`
            : "Ranked by artist, frame labels, set and release era"}
        </span>
      </div>
      {report.warnings.map((warning) => (
        <div className="notice warning" key={warning}>
          <span>{warning}</span>
        </div>
      ))}
      <div className="style-rows">
        {report.matches.map((match) => {
          const target = targets.find((item) => item.id === match.entryId);
          if (!target) return null;
          const current = frontArt(target);
          const pick = picks[match.entryId];
          const shown = match.ranked
            .filter((item) => item.art.id !== current.id)
            .slice(0, SHOWN);
          const detail = pick
            ? match.ranked.find((item) => item.art.id === pick.id)
            : match.ranked.find((item) => item.art.id === current.id);
          return (
            <div className="style-row" key={match.entryId}>
              <div className="style-current">
                <CardImage url={current.thumbnailUrl} name={target.card.name} />
                <div>
                  <strong>{target.card.name}</strong>
                  <small className="muted style-ellipsis">
                    {current.artist}
                    {current.set ? ` · ${current.set.toUpperCase()}` : ""}
                  </small>
                </div>
              </div>
              <ArrowRight size={15} className="muted" aria-hidden="true" />
              <fieldset
                className="style-options"
                aria-label={`Printing for ${target.card.name}`}
              >
                <button
                  type="button"
                  aria-pressed={!pick}
                  className="style-option keep"
                  title="Keep the current printing"
                  onClick={() => onPick(match.entryId, undefined)}
                >
                  Keep
                </button>
                {shown.map((item) => (
                  <OptionButton
                    key={item.art.id}
                    item={item}
                    checked={pick?.id === item.art.id}
                    onClick={() => onPick(match.entryId, item.art)}
                  />
                ))}
                {!shown.length && (
                  <span className="hint">No other printings</span>
                )}
              </fieldset>
              <div className="style-detail">
                {detail && (
                  <>
                    <div className="style-score">
                      <span
                        className="style-bar"
                        style={{ width: `${Math.round(detail.score * 100)}%` }}
                      />
                    </div>
                    <small className="muted style-reasons">
                      {detail.reasons.length
                        ? detail.reasons.join(" · ")
                        : "Nothing in common with the reference"}
                    </small>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function OptionButton({
  item,
  checked,
  onClick,
}: {
  item: ScoredArt;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      className="style-option"
      aria-label={`Use ${item.art.source} ${item.art.collectorNumber} by ${item.art.artist}`}
      title={`${item.art.artist} · ${item.art.source}\n${item.reasons.join(", ")}`}
      onClick={onClick}
    >
      <CardImage url={item.art.thumbnailUrl} name={item.art.name} />
      <span className="mono">{Math.round(item.score * 100)}</span>
    </button>
  );
}
