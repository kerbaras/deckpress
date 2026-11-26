import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.ts";
import type { DeckEntry } from "./core/index.ts";
import { ErrorNotice, StatusRegion } from "./ui.tsx";

const noTokens = "No additional tokens or emblems found.";

export function TokenSuggestions({
  entries,
  onAdd,
}: {
  entries: DeckEntry[];
  onAdd: (entry: DeckEntry) => void;
}) {
  const [show, setShow] = useState(false);
  const producerIds = [
    ...new Set(
      entries
        .filter(
          (entry) =>
            !entry.excluded &&
            entry.zone !== "tokens" &&
            entry.card.faces[0]?.provider === "scryfall",
        )
        .map((entry) => entry.card.id),
    ),
  ].sort();
  const suggestions = useQuery({
    queryKey: ["related-tokens", producerIds],
    queryFn: () => api.relatedTokens(producerIds),
    enabled: show && producerIds.length > 0,
    staleTime: 24 * 60 * 60 * 1000,
  });
  if (!producerIds.length) return null;
  const existing = new Set(entries.map((entry) => entry.card.oracleId));
  const missing = suggestions.data?.filter(
    (entry) => !existing.has(entry.card.oracleId),
  );
  const finding = show && suggestions.isPending;
  const count = show && !suggestions.isError ? missing?.length : undefined;
  const status = finding
    ? "Finding tokens…"
    : count === 0
      ? noTokens
      : count
        ? `Found ${count} additional ${count === 1 ? "token or emblem" : "tokens or emblems"}.`
        : "";
  return (
    <section
      className="panel import-panel"
      aria-label="Related tokens and emblems"
    >
      <div className="section-heading">
        <h3>Related tokens and emblems</h3>
        <button
          type="button"
          aria-expanded={show}
          onClick={() => setShow(!show)}
        >
          {show ? "Hide suggestions" : "Find tokens"}
        </button>
      </div>
      <StatusRegion label="Token lookup status" coalesce>
        {status}
      </StatusRegion>
      {(finding || count === 0) && (
        <p className="hint" aria-hidden="true">
          {status}
        </p>
      )}
      {show && (
        <>
          <ErrorNotice
            error={suggestions.error}
            retry={() => void suggestions.refetch()}
          />
          {missing && missing.length > 0 && (
            <ul className="token-suggestions">
              {missing.map((entry) => (
                <li key={entry.card.id}>
                  <span>{entry.card.name}</span>
                  <button
                    type="button"
                    aria-label={`Add ${entry.card.name}`}
                    onClick={() => onAdd(entry)}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
