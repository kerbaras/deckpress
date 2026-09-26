import { useQuery } from "@tanstack/react-query";
import { Check, Crown } from "lucide-react";
import { useEffect, useState } from "react";
import {
  api,
  type BuilderFormat,
  type BuilderOptions,
  type Suggestion,
} from "./api.ts";
import type { Card } from "./core/index.ts";
import type { WizardState } from "./deck-builder-model.ts";
import {
  CardImage,
  ErrorNotice,
  Loading,
  ManaPips,
  SearchField,
} from "./ui.tsx";

interface StepProps {
  options: BuilderOptions;
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
}

export function StepIntro({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <header className="builder-intro">
      <h2>{title}</h2>
      <p className="muted">{children}</p>
    </header>
  );
}

export function FormatStep({ options, state, update }: StepProps) {
  const choose = (format: BuilderFormat) =>
    update({
      format,
      set: format.needsSet ? state.set : "",
      commander: format.commander ? state.commander : null,
    });
  return (
    <section className="builder-step">
      <StepIntro title="What are you building?">
        The format sets the deck size, the copy limit and which cards Scryfall
        will offer.
      </StepIntro>
      <div className="builder-options">
        {options.formats.map((format) => {
          const active = state.format?.id === format.id;
          return (
            <button
              type="button"
              key={format.id}
              aria-pressed={active}
              className="builder-option"
              onClick={() => choose(format)}
            >
              <span className="builder-option-head">
                <strong>{format.name}</strong>
                {active && <Check size={15} aria-hidden="true" />}
              </span>
              <span className="builder-option-body">{format.description}</span>
              <span className="builder-option-meta mono">
                {format.deckSize} cards ·{" "}
                {format.singleton ? "singleton" : `${format.maxCopies} copies`}{" "}
                · {format.landTarget} lands
              </span>
            </button>
          );
        })}
      </div>
      {state.format?.needsSet && (
        <SetPicker value={state.set} onChange={(set) => update({ set })} />
      )}
    </section>
  );
}

function SetPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  const sets = useQuery({
    queryKey: ["builder", "sets"],
    queryFn: ({ signal }) => api.builderSets(signal),
    staleTime: 24 * 60 * 60 * 1000,
  });
  return (
    <div className="builder-set">
      <ErrorNotice error={sets.error} retry={() => void sets.refetch()} />
      {sets.isPending ? (
        <Loading>Loading draftable sets from Scryfall…</Loading>
      ) : (
        <label className="field">
          Set you drafted
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Choose a set…</option>
            {(sets.data ?? []).map((set) => (
              <option key={set.code} value={set.code}>
                {set.name} ({set.code.toUpperCase()}) ·{" "}
                {set.releasedAt.slice(0, 4)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export function CommanderStep({ options, state, update }: StepProps) {
  const [query, setQuery] = useState(state.commander?.name ?? "");
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [query]);
  const search = useQuery({
    queryKey: ["builder", "commanders", debounced],
    queryFn: ({ signal }) => api.builderCommanders(debounced, [], signal),
    enabled: debounced.length >= 2,
    staleTime: 10 * 60 * 1000,
  });
  const pick = (card: Card) => update({ commander: card, colors: card.colors });
  return (
    <section className="builder-step">
      <StepIntro title="Who leads the deck?">
        Pick a commander. Its colour identity becomes the deck's, and its rules
        text tells the builder which themes it rewards.
      </StepIntro>
      <div className="toolbar">
        <SearchField
          label="Search legendary creatures by name"
          value={query}
          onChange={setQuery}
        />
        <span className="hint">Ranked by EDHREC popularity, via Scryfall.</span>
      </div>
      {state.commander && (
        <div className="builder-chosen panel">
          <Crown size={16} aria-hidden="true" />
          <span>
            Commander: <strong>{state.commander.name}</strong>
          </span>
          <ManaPips colors={state.commander.colors} />
          <button
            type="button"
            className="quiet builder-chosen-clear"
            onClick={() => update({ commander: null })}
          >
            Change
          </button>
        </div>
      )}
      <ErrorNotice error={search.error} retry={() => void search.refetch()} />
      {debounced.length < 2 ? (
        <div className="empty-state">
          <Crown size={34} />
          <h3>Type at least two letters</h3>
          <p>
            Try “Atraxa”, “Krenko” or “Muldrotha”. Any legendary creature or
            planeswalker that can be your commander will appear.
          </p>
        </div>
      ) : search.isPending ? (
        <Loading>Searching Scryfall…</Loading>
      ) : !search.data?.length ? (
        <div className="empty-state">
          <h3>No commanders match “{debounced}”</h3>
          <p>Check the spelling or try the first word of the name only.</p>
        </div>
      ) : (
        <ul className="builder-commanders">
          {search.data.map((item) => (
            <CommanderRow
              key={item.card.id}
              item={item}
              selected={state.commander?.id === item.card.id}
              onPick={() => pick(item.card)}
            />
          ))}
        </ul>
      )}
      <p className="hint">
        Themes the builder recognises:{" "}
        {options.themes
          .filter((theme) => theme.cues.length)
          .map((theme) => theme.name.toLowerCase())
          .join(", ")}
        .
      </p>
    </section>
  );
}

function CommanderRow({
  item,
  selected,
  onPick,
}: {
  item: Suggestion;
  selected: boolean;
  onPick: () => void;
}) {
  const face = item.card.faces[0];
  return (
    <li>
      <button
        type="button"
        className="builder-commander"
        aria-pressed={selected}
        onClick={onPick}
      >
        {face && (
          <CardImage
            className="builder-thumb"
            url={face.thumbnailUrl}
            name={item.card.name}
          />
        )}
        <span className="builder-commander-body">
          <span className="builder-commander-name">
            <strong>{item.card.name}</strong>
            <ManaPips colors={item.card.colors} />
          </span>
          <span className="hint">{item.card.typeLine}</span>
          {item.reasons.length > 0 && (
            <span className="builder-reasons">{item.reasons.join(" · ")}</span>
          )}
        </span>
        {selected && <Check size={16} aria-hidden="true" />}
      </button>
    </li>
  );
}

export function ColorsStep({ options, state, update }: StepProps) {
  const toggle = (id: string) =>
    update({
      colors: state.colors.includes(id)
        ? state.colors.filter((color) => color !== id)
        : [...state.colors, id],
    });
  return (
    <section className="builder-step">
      <StepIntro title="Which colours?">
        Cards outside this colour identity are left out. Leave everything off
        for a colourless deck; two colours is the sweet spot for 60-card decks.
      </StepIntro>
      <fieldset className="builder-colors">
        <legend className="sr-only">Colour identity</legend>
        {options.colors.map((color) => {
          const active = state.colors.includes(color.id);
          return (
            <button
              type="button"
              key={color.id}
              className="builder-color"
              aria-pressed={active}
              onClick={() => toggle(color.id)}
            >
              <span className={`mana mana-${color.id}`}>{color.id}</span>
              <span>{color.name}</span>
            </button>
          );
        })}
      </fieldset>
      <p className="hint">
        {state.colors.length === 0
          ? "Colourless: artifacts and lands only."
          : `Identity: ${state.colors.join("")} · basics will be ${state.colors
              .map(
                (id) =>
                  options.colors.find((color) => color.id === id)?.basic ?? id,
              )
              .join(", ")}.`}
      </p>
    </section>
  );
}

export function StyleStep({ options, state, update }: StepProps) {
  const theme = options.themes.find((item) => item.id === state.theme);
  return (
    <section className="builder-step">
      <StepIntro title="How does it want to win?">
        The play style shapes the mana curve and land count. The theme decides
        which rules text counts as synergy.
      </StepIntro>
      <h3>Play style</h3>
      <div className="builder-options builder-styles">
        {options.styles.map((style) => {
          const active = state.style === style.id;
          return (
            <button
              type="button"
              key={style.id}
              aria-pressed={active}
              className="builder-option"
              onClick={() => update({ style: style.id })}
            >
              <span className="builder-option-head">
                <strong>{style.name}</strong>
                {active && <Check size={15} aria-hidden="true" />}
              </span>
              <span className="builder-option-body">{style.description}</span>
              <CurveSketch curve={style.curve} />
            </button>
          );
        })}
      </div>
      <h3>Theme</h3>
      <div className="chips">
        {options.themes.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={state.theme === item.id}
            className={`chip ${state.theme === item.id ? "active" : ""}`}
            title={item.description}
            onClick={() => update({ theme: item.id })}
          >
            {item.name}
          </button>
        ))}
      </div>
      {theme && <p className="hint">{theme.description}</p>}
      {theme?.needsTribe && (
        <label className="field builder-tribe">
          Creature type
          <input
            maxLength={40}
            placeholder="Elf, Goblin, Dragon…"
            value={state.tribe}
            onChange={(event) => update({ tribe: event.target.value })}
          />
        </label>
      )}
    </section>
  );
}

/** Tiny bar chart of a style's target curve, shares of non-land cards. */
function CurveSketch({ curve }: { curve: number[] }) {
  const max = Math.max(...curve, 0.01);
  return (
    <span className="builder-sketch" aria-hidden="true">
      {curve.map((share, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bucket order
          key={index}
          className="builder-sketch-bar"
          style={{ height: `${Math.round((share / max) * 100)}%` }}
        />
      ))}
    </span>
  );
}
