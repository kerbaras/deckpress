import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Minus,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type BuilderOptions,
  type BuilderSpec,
  type BuilderSummary,
  type Suggestion,
} from "./api.ts";
import type { Card, DeckEntry } from "./core/index.ts";
import {
  addCard,
  blocker,
  commanderEntry,
  copiesOf,
  copyLimit,
  deckFormatOf,
  defaultDeckName,
  emptyState,
  fitEntries,
  isLand,
  mergeEntries,
  orderEntries,
  removeCard,
  roleName,
  roleNames,
  type StepId,
  scorePercent,
  setQuantity,
  stepNames,
  stepsFor,
  toSpec,
  type WizardState,
} from "./deck-builder-model.ts";
import {
  ColorsStep,
  CommanderStep,
  FormatStep,
  StyleStep,
} from "./deck-builder-steps.tsx";
import { PageToolbar } from "./titlebar.tsx";
import {
  CardImage,
  countCards,
  ErrorNotice,
  Loading,
  ManaPips,
  useTask,
} from "./ui.tsx";

export function DeckBuilder({
  onBack,
  onCreated,
  onDirty,
}: {
  onBack: () => void;
  onCreated: (id: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const options = useQuery({
    queryKey: ["builder", "options"],
    queryFn: ({ signal }) => api.builderOptions(signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (options.isPending) {
    return (
      <>
        <PageToolbar title="Deck builder" />
        <Loading>Loading builder…</Loading>
      </>
    );
  }
  if (options.isError || !options.data) {
    return (
      <>
        <PageToolbar title="Deck builder" />
        <div className="page-content">
          <ErrorNotice
            error={options.error}
            retry={() => void options.refetch()}
          />
        </div>
      </>
    );
  }
  return (
    <Wizard
      options={options.data}
      onBack={onBack}
      onCreated={onCreated}
      onDirty={onDirty}
    />
  );
}

function Wizard({
  options,
  onBack,
  onCreated,
  onDirty,
}: {
  options: BuilderOptions;
  onBack: () => void;
  onCreated: (id: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const [state, setState] = useState<WizardState>(emptyState);
  const [index, setIndex] = useState(0);
  const [entries, setEntries] = useState<DeckEntry[]>([]);
  const [name, setName] = useState("");
  const task = useTask();
  const steps = stepsFor(state.format);
  const step: StepId = steps[Math.min(index, steps.length - 1)] ?? "format";
  const stop = blocker(state, step, options.themes);
  const spec = toSpec(state);
  const update = (patch: Partial<WizardState>) => {
    const next = { ...state, ...patch };
    setEntries(fitEntries(entries, state, next));
    setState(next);
  };
  const picked = entries.length > 0 || name.trim() !== "";
  useEffect(() => {
    onDirty(picked);
    return () => onDirty(false);
  }, [picked, onDirty]);
  const styleName =
    options.styles.find((style) => style.id === state.style)?.name ?? "";
  const themeName =
    options.themes.find((theme) => theme.id === state.theme)?.name ?? "";
  const suggestedName = defaultDeckName(state, styleName, themeName);

  const next = () => {
    if (stop) return;
    if (steps[index + 1] === "cards") {
      setEntries((current) => {
        const kept = current.filter((entry) => entry.zone !== "commander");
        return state.commander
          ? [commanderEntry(state.commander), ...kept]
          : kept;
      });
    }
    setIndex((current) => Math.min(current + 1, steps.length - 1));
  };
  const back = () => setIndex((current) => Math.max(current - 1, 0));

  const create = () =>
    void task.run(async () => {
      if (!spec || !state.format) return;
      const cover = entries[0];
      const deck = await api.createDeck({
        name: (name.trim() || suggestedName || "New deck").slice(0, 100),
        format: deckFormatOf(state.format),
        entries,
        ...(cover ? { coverEntryId: cover.id } : {}),
      });
      await client.invalidateQueries({ queryKey: ["decks"] });
      onDirty(false);
      onCreated(deck.id);
    });

  const count = countCards(entries);
  const target = state.format?.deckSize ?? 0;
  return (
    <>
      <PageToolbar
        title="Deck builder"
        subtitle={`Step ${index + 1} of ${steps.length} · ${stepNames[step]}`}
        leading={
          <button
            type="button"
            className="icon-button quiet"
            aria-label="Back to decks"
            title="Back to decks"
            onClick={onBack}
          >
            <ArrowLeft size={16} />
          </button>
        }
        center={
          <ol className="builder-progress" aria-label="Steps">
            {steps.map((id, at) => (
              <li
                key={id}
                aria-current={at === index ? "step" : undefined}
                data-done={at < index ? "true" : undefined}
              >
                <button
                  type="button"
                  disabled={at > index}
                  onClick={() => setIndex(at)}
                >
                  <span className="builder-progress-index mono">{at + 1}</span>
                  <span className="builder-progress-name">{stepNames[id]}</span>
                </button>
              </li>
            ))}
          </ol>
        }
      >
        {index > 0 && (
          <button type="button" onClick={back} disabled={task.busy}>
            <ArrowLeft size={15} />
            Back
          </button>
        )}
        {step !== "cards" ? (
          <button
            type="button"
            className="primary"
            disabled={Boolean(stop)}
            title={stop ?? undefined}
            onClick={next}
          >
            Next
            <ArrowRight size={15} />
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={task.busy || entries.length === 0}
            title={
              entries.length === 0
                ? "Add at least one card first"
                : count === target
                  ? "Create the deck and open it"
                  : `Create with ${count} of ${target} cards; finish it in the editor`
            }
            onClick={create}
          >
            <Check size={15} />
            {task.busy ? "Creating…" : "Create deck"}
          </button>
        )}
      </PageToolbar>
      <div className="page-content builder">
        <ErrorNotice error={task.error} />
        {step === "format" && (
          <FormatStep options={options} state={state} update={update} />
        )}
        {step === "commander" && (
          <CommanderStep options={options} state={state} update={update} />
        )}
        {step === "colors" && (
          <ColorsStep options={options} state={state} update={update} />
        )}
        {step === "style" && (
          <StyleStep options={options} state={state} update={update} />
        )}
        {step === "cards" && spec && state.format && (
          <CardsStage
            spec={spec}
            maxCopies={state.format.maxCopies}
            entries={entries}
            setEntries={setEntries}
            name={name}
            suggestedName={suggestedName}
            setName={setName}
          />
        )}
        {stop && step !== "cards" && (
          <p className="hint builder-blocker" role="status">
            {stop}.
          </p>
        )}
      </div>
    </>
  );
}

function CardsStage({
  spec,
  maxCopies,
  entries,
  setEntries,
  name,
  suggestedName,
  setName,
}: {
  spec: BuilderSpec;
  maxCopies: number;
  entries: DeckEntry[];
  setEntries: (update: (entries: DeckEntry[]) => DeckEntry[]) => void;
  name: string;
  suggestedName: string;
  setName: (name: string) => void;
}) {
  const [role, setRole] = useState("all");
  const fill = useTask();
  const latest = useRef(entries);
  latest.current = entries;
  const suggestions = useInfiniteQuery({
    queryKey: ["builder", "suggest", spec],
    queryFn: ({ pageParam, signal }) =>
      api.builderSuggest(spec, pageParam, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    staleTime: 10 * 60 * 1000,
  });
  const first = suggestions.data?.pages[0];
  const summary = useQuery({
    queryKey: ["builder", "summary", spec, entries],
    queryFn: () => api.builderSummary(spec, entries),
    placeholderData: (previous) => previous,
  });
  const items = useMemo(
    () => suggestions.data?.pages.flatMap((page) => page.items) ?? [],
    [suggestions.data],
  );
  const roles = useMemo(() => {
    const present = new Set(items.map((item) => item.role));
    return Object.keys(roleNames).filter((id) => present.has(id));
  }, [items]);
  const shown =
    role === "all" ? items : items.filter((item) => item.role === role);
  const add = (card: Card) =>
    setEntries((current) => addCard(current, card, maxCopies));
  const remaining = summary.data
    ? Math.max(0, summary.data.target - summary.data.count)
    : 0;
  const runFill = () =>
    void fill.run(async () => {
      const added = await api.builderFill(spec, entries);
      if (latest.current !== entries)
        throw new Error(
          "The deck changed while filling; use Fill remaining slots again",
        );
      setEntries((current) => mergeEntries(current, added));
    });
  return (
    <div className="builder-stage">
      <section className="builder-suggestions" aria-label="Suggestions">
        <div className="section-heading">
          <h3>
            <Sparkles size={15} aria-hidden="true" />
            Suggestions
            {first && <span className="muted"> · {first.total} cards</span>}
          </h3>
          {roles.length > 1 && (
            <div className="chips">
              <button
                type="button"
                className={`chip ${role === "all" ? "active" : ""}`}
                onClick={() => setRole("all")}
              >
                All
              </button>
              {roles.map((id) => (
                <button
                  type="button"
                  key={id}
                  className={`chip ${role === id ? "active" : ""}`}
                  onClick={() => setRole(id)}
                >
                  {roleName(id)}
                </button>
              ))}
            </div>
          )}
        </div>
        {first?.queries[0] && (
          <p className="hint builder-source">
            Pool: Scryfall search <code>{first.queries[0]}</code>
            {first.queries.length > 1 &&
              ` and ${first.queries.length - 1} theme ${
                first.queries.length === 2 ? "query" : "queries"
              }`}
            . Scores are a transparent heuristic; each card lists why.
          </p>
        )}
        <ErrorNotice
          error={suggestions.error}
          retry={() => void suggestions.refetch()}
        />
        {suggestions.isPending && items.length === 0 ? (
          <Loading>Searching Scryfall and scoring cards…</Loading>
        ) : !suggestions.isError && items.length === 0 ? (
          <div className="empty-state">
            <Sparkles size={34} />
            <h3>Scryfall returned no cards for this combination</h3>
            <p>
              Go back and widen the colour identity, pick a different theme, or
              choose another set.
            </p>
          </div>
        ) : shown.length === 0 && items.length > 0 ? (
          <div className="empty-state">
            <h3>No {roleName(role).toLowerCase()} cards on these pages</h3>
            <p>Load more suggestions or clear the role filter.</p>
          </div>
        ) : (
          <ul className="builder-list">
            {shown.map((item) => {
              const owned = copiesOf(entries, item.card);
              const limit = copyLimit(item.card, maxCopies);
              return (
                <SuggestionRow
                  key={item.card.id}
                  item={item}
                  owned={owned}
                  limit={limit}
                  onAdd={() => add(item.card)}
                />
              );
            })}
          </ul>
        )}
        {suggestions.hasNextPage && (
          <button
            type="button"
            className="wide"
            disabled={suggestions.isFetchingNextPage}
            onClick={() => void suggestions.fetchNextPage()}
          >
            {suggestions.isFetchingNextPage
              ? "Loading…"
              : "Load more suggestions"}
          </button>
        )}
      </section>
      <aside className="builder-summary panel" aria-label="Deck in progress">
        <label className="field">
          Deck name
          <input
            maxLength={100}
            placeholder={suggestedName || "New deck"}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <ErrorNotice error={summary.error ?? fill.error} />
        {summary.data ? (
          <SummaryPanel summary={summary.data} />
        ) : (
          <Loading>Counting…</Loading>
        )}
        <button
          type="button"
          className="wide"
          disabled={fill.busy || remaining === 0 || !summary.data}
          title={
            remaining === 0
              ? "The deck is already at its target size"
              : `Add ${remaining} cards: top suggestions, then basic lands`
          }
          onClick={runFill}
        >
          <Wand2 size={15} />
          {fill.busy
            ? "Filling…"
            : remaining
              ? `Fill remaining ${remaining} slots`
              : "Deck is full"}
        </button>
        <DeckList
          entries={entries}
          maxCopies={maxCopies}
          onQuantity={(id, quantity) =>
            setEntries((current) =>
              setQuantity(current, id, quantity, maxCopies),
            )
          }
          onRemove={(id) => setEntries((current) => removeCard(current, id))}
        />
      </aside>
    </div>
  );
}

function SuggestionRow({
  item,
  owned,
  limit,
  onAdd,
}: {
  item: Suggestion;
  owned: number;
  limit: number;
  onAdd: () => void;
}) {
  const face = item.card.faces[0];
  const full = owned >= limit;
  return (
    <li
      className="builder-suggestion"
      data-owned={owned > 0 ? "true" : undefined}
    >
      {face && (
        <CardImage
          className="builder-thumb"
          url={face.thumbnailUrl}
          name={item.card.name}
        />
      )}
      <div className="builder-suggestion-body">
        <div className="builder-suggestion-head">
          <strong>{item.card.name}</strong>
          <ManaPips colors={item.card.colors} />
          <span className="badge">{roleName(item.role)}</span>
          <span
            className="builder-score mono"
            title="Synergy score, 0 to 100"
            style={{ ["--score" as string]: scorePercent(item.score) }}
          >
            {scorePercent(item.score)}
          </span>
        </div>
        <span className="hint">
          {item.card.typeLine}
          {item.card.manaCost && ` · ${item.card.manaCost}`}
        </span>
        <p className="builder-reasons">{item.reasons.join(" · ")}</p>
      </div>
      <button
        type="button"
        className={owned > 0 ? "" : "primary"}
        disabled={full}
        aria-label={`Add ${item.card.name}`}
        title={
          full
            ? limit === 1
              ? "Already in the deck (singleton)"
              : `Already at ${limit} copies`
            : "Add to deck"
        }
        onClick={onAdd}
      >
        {full ? <Check size={15} /> : <Plus size={15} />}
        {owned > 0 ? `${owned}/${limit}` : "Add"}
      </button>
    </li>
  );
}

function SummaryPanel({ summary }: { summary: BuilderSummary }) {
  const max = Math.max(
    ...summary.curve.map((bucket) => Math.max(bucket.count, bucket.target)),
    1,
  );
  const totalPips = summary.colors.reduce((sum, share) => sum + share.pips, 0);
  return (
    <div className="builder-stats">
      <div className="builder-count">
        <span className="builder-count-value">
          <strong>{summary.count}</strong>
          <span className="muted"> / {summary.target}</span>
        </span>
        <span className="hint">
          {summary.singleton
            ? "singleton"
            : `up to ${summary.maxCopies} copies`}{" "}
          · {summary.lands} of ~{summary.landTarget} lands
        </span>
      </div>
      <progress
        aria-label="Cards added"
        value={summary.count}
        max={summary.target}
      />
      <div className="builder-curve" role="img" aria-label="Mana curve">
        {summary.curve.map((bucket) => (
          <div
            key={bucket.label}
            className="builder-curve-col"
            title={`${bucket.count} cards at mana value ${bucket.label}, target about ${bucket.target}`}
          >
            <span className="builder-curve-bars">
              <span
                className="builder-curve-target"
                style={{ height: `${(bucket.target / max) * 100}%` }}
              />
              <span
                className="builder-curve-bar"
                data-over={bucket.count > bucket.target ? "true" : undefined}
                style={{ height: `${(bucket.count / max) * 100}%` }}
              />
            </span>
            <span className="mono">{bucket.label}</span>
          </div>
        ))}
      </div>
      {summary.colors.length > 0 && (
        <div className="builder-pips" role="img" aria-label="Colour breakdown">
          <span className="builder-pip-bar">
            {summary.colors.map((share) => (
              <span
                key={share.color}
                className={`mana-${share.color}`}
                style={{ flex: share.pips || 1 }}
                title={`${share.color}: ${share.pips} pips in ${share.cards} cards`}
              />
            ))}
          </span>
          <span className="builder-pip-legend">
            {summary.colors.map((share) => (
              <span key={share.color} className="builder-pip-item">
                <span className={`mana mana-${share.color} builder-pip-mana`}>
                  {share.color}
                </span>
                <span className="mono">
                  {totalPips
                    ? `${Math.round((share.pips / totalPips) * 100)}%`
                    : "–"}
                </span>
              </span>
            ))}
          </span>
        </div>
      )}
      {summary.issues.length > 0 && (
        <ul className="builder-issues">
          {summary.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {summary.complete && (
        <p className="builder-ready">
          <Check size={14} aria-hidden="true" /> Ready to create.
        </p>
      )}
    </div>
  );
}

function DeckList({
  entries,
  maxCopies,
  onQuantity,
  onRemove,
}: {
  entries: DeckEntry[];
  maxCopies: number;
  onQuantity: (id: string, quantity: number) => void;
  onRemove: (id: string) => void;
}) {
  const ordered = orderEntries(entries);
  if (!ordered.length) {
    return (
      <div className="empty-state builder-empty">
        <h3>Nothing added yet</h3>
        <p>
          Add cards from the suggestions on the left, or press “Fill remaining
          slots” to start from the top picks.
        </p>
      </div>
    );
  }
  return (
    <ul className="builder-deck" aria-label="Cards in the deck">
      {ordered.map((entry) => {
        const limit = copyLimit(entry.card, maxCopies);
        const locked = entry.zone === "commander";
        return (
          <li key={entry.id} data-zone={entry.zone}>
            <span className="builder-deck-name">
              <span className="mono">{entry.quantity}×</span>
              <span className="builder-deck-title" title={entry.card.typeLine}>
                {entry.card.name}
              </span>
              {locked && <span className="badge">Commander</span>}
              {isLand(entry.card) && !locked && (
                <span className="badge">Land</span>
              )}
            </span>
            <span className="builder-qty">
              {!locked && limit > 1 && (
                <>
                  <button
                    type="button"
                    className="icon-button quiet"
                    aria-label={`One fewer ${entry.card.name}`}
                    onClick={() => onQuantity(entry.id, entry.quantity - 1)}
                  >
                    <Minus size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button quiet"
                    aria-label={`One more ${entry.card.name}`}
                    disabled={entry.quantity >= limit}
                    title={
                      entry.quantity >= limit ? `Limit ${limit}` : undefined
                    }
                    onClick={() => onQuantity(entry.id, entry.quantity + 1)}
                  >
                    <Plus size={13} />
                  </button>
                </>
              )}
              {!locked && (
                <button
                  type="button"
                  className="icon-button quiet"
                  aria-label={`Remove ${entry.card.name}`}
                  onClick={() => onRemove(entry.id)}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
