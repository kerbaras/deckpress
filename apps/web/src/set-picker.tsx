import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { api, imageSrc } from "./api.ts";
import {
  formatSetCoverage,
  type SetInfo,
  searchSets,
  suggestedSets,
} from "./core/sets.ts";
import { useSetCatalog } from "./set-catalog.ts";
import { StatusRegion } from "./ui.tsx";
import "./set-picker.css";

function SetIcon({ set }: { set: SetInfo }) {
  const [failed, setFailed] = useState(false);
  return failed || !set.iconSvgUri ? (
    <span className="badge" aria-hidden="true">
      {set.code.toUpperCase()}
    </span>
  ) : (
    <img
      className="set-picker-icon"
      src={imageSrc(set.iconSvgUri)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export function SetPicker({
  deckId,
  revision,
  value,
  disabled,
  onChange,
}: {
  deckId: string;
  revision: number;
  value: string;
  disabled: boolean;
  onChange: (code: string) => void;
}) {
  const id = useId();
  const listId = `${id}-sets`;
  const optionId = (code: string) => `${listId}-${code}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>();
  const expanded = open && !disabled;
  const showSuggestions = !query.trim();
  const catalog = useSetCatalog();
  const coverage = useQuery({
    queryKey: ["set-coverage", deckId, revision],
    queryFn: () => api.setCoverage(deckId),
    enabled: expanded && showSuggestions,
    staleTime: 86_400_000,
    retry: false,
  });
  const suggestions = showSuggestions ? suggestedSets(coverage.data ?? []) : [];
  const suggested = new Set(suggestions.map(({ set }) => set.code));
  const results = searchSets(catalog.data ?? [], query).filter(
    (set) => !suggested.has(set.code),
  );
  const options = [...suggestions.map(({ set }) => set), ...results];
  const selected = catalog.data?.find((set) => set.code === value);
  const activeIndex = options.findIndex((set) => set.code === active);
  const activeId =
    expanded && activeIndex >= 0 && active ? optionId(active) : undefined;
  useEffect(() => {
    if (activeId)
      document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  function close() {
    setOpen(false);
    setActive(undefined);
    setQuery("");
  }

  function select(code: string) {
    onChange(code);
    close();
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        setOpen(true);
        const next =
          event.key === "ArrowDown"
            ? Math.min(activeIndex + 1, options.length - 1)
            : activeIndex < 0
              ? options.length - 1
              : Math.max(activeIndex - 1, 0);
        setActive(options[next]?.code);
        break;
      }
      case "Enter": {
        if (!expanded) break;
        event.preventDefault();
        const option = options[Math.max(0, activeIndex)];
        if (option) select(option.code);
        break;
      }
      case "Escape":
        if (!expanded) break;
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
    }
  }

  function option(set: SetInfo, count?: string) {
    return (
      <div
        key={set.code}
        id={optionId(set.code)}
        role="option"
        tabIndex={-1}
        aria-selected={set.code === value}
        data-active={set.code === active || undefined}
        className="set-picker-option"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => select(set.code)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select(set.code);
          }
        }}
      >
        <SetIcon key={set.iconSvgUri} set={set} />
        <span className="set-picker-name">
          {set.name}
          <span className="hint">
            {set.code.toUpperCase()} · {set.releasedAt}
          </span>
        </span>
        {count && <span className="set-picker-count">{count}</span>}
      </div>
    );
  }

  return (
    <div className="field set-picker">
      <label htmlFor={id}>Set</label>
      <input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={activeId}
        type="text"
        autoComplete="off"
        placeholder="Search by set name or code"
        disabled={disabled}
        value={expanded ? query : (selected?.name ?? value.toUpperCase())}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={close}
        onKeyDown={keyDown}
        onChange={(event) => {
          setOpen(true);
          setQuery(event.target.value);
          setActive(undefined);
        }}
      />
      {expanded && (
        <>
          {showSuggestions && coverage.isFetching && (
            <StatusRegion className="hint">
              Finding suggested sets for this deck…
            </StatusRegion>
          )}
          {showSuggestions && coverage.isError && (
            <p className="hint" role="alert">
              Could not load suggested sets. You can still search.
            </p>
          )}
          {catalog.isFetching && (
            <StatusRegion className="hint">Loading Scryfall sets…</StatusRegion>
          )}
          {catalog.isError && (
            <p className="hint" role="alert">
              Could not load Scryfall sets.
            </p>
          )}
          <div
            id={listId}
            role="listbox"
            aria-label="Sets"
            className="set-picker-results"
            hidden={!options.length}
          >
            {suggestions.length > 0 && (
              <fieldset
                className="set-picker-section"
                aria-label="Suggested for this deck"
              >
                <div className="set-picker-group" aria-hidden="true">
                  Suggested for this deck
                </div>
                {suggestions.map((row) =>
                  option(row.set, formatSetCoverage(row)),
                )}
              </fieldset>
            )}
            {results.length > 0 && (
              <fieldset
                className="set-picker-section"
                aria-label="Search results"
              >
                {suggestions.length > 0 && (
                  <div className="set-picker-group" aria-hidden="true">
                    More sets
                  </div>
                )}
                {results.map((set) => option(set))}
              </fieldset>
            )}
          </div>
          {!options.length && catalog.isSuccess && (
            <StatusRegion className="hint">No matching sets.</StatusRegion>
          )}
        </>
      )}
    </div>
  );
}
