import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Heart,
  ExternalLink as LinkIcon,
  RotateCcw,
  Sparkles,
  Upload,
  ZoomIn,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api, type Preferences } from "./api.ts";
import {
  type Art,
  artPreferenceSchema,
  backArt,
  type Deck,
  type DeckEntry,
  frontArt,
} from "./core/index.ts";
import { StyleMatch } from "./style-match.tsx";
import {
  CardImage,
  ErrorNotice,
  ExternalLink,
  Loading,
  Modal,
  providerName,
  SearchField,
  StatusRegion,
  useTask,
} from "./ui.tsx";

export function ArtPicker(props: {
  deck: Deck;
  entry: DeckEntry;
  onSelect: (id: string) => void;
  onApply: (deck: Deck) => Promise<Deck>;
}) {
  const { entry, onSelect } = props;
  const [activeFace, setActiveFace] = useState({ entryId: entry.id, face: 0 });
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [applied, setApplied] = useState({ sequence: 0, printing: "" });
  const face = activeFace.entryId === entry.id ? activeFace.face : 0;
  const heading = useRef<HTMLHeadingElement>(null);
  const previousEntry = useRef(entry.id);
  useEffect(() => {
    if (previousEntry.current !== entry.id) {
      previousEntry.current = entry.id;
      heading.current?.focus();
    }
  }, [entry.id]);
  return (
    <>
      <StatusRegion label="Art match count">
        {matchCount !== null && matchSummary(matchCount)}
      </StatusRegion>
      <StatusRegion label="Art apply status">
        {applied.sequence > 0 && (
          <span key={applied.sequence}>Applied: {applied.printing}</span>
        )}
      </StatusRegion>
      <ArtSession
        key={`${entry.id}:${face}`}
        {...props}
        face={face}
        setFace={(nextFace) =>
          setActiveFace({ entryId: entry.id, face: nextFace })
        }
        onSelect={(id, nextFace = 0) => {
          setActiveFace({ entryId: id, face: nextFace });
          onSelect(id);
        }}
        heading={heading}
        onMatchCount={setMatchCount}
        onApplied={(printing) =>
          setApplied(({ sequence }) => ({ sequence: sequence + 1, printing }))
        }
      />
    </>
  );
}

const matchSummary = (count: number) =>
  `${count} ${count === 1 ? "match" : "matches"} in loaded results`;

const normalizeTag = (tag: string) =>
  tag
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/^extendedart$/, "extended art");

export function filterArt(
  items: Art[],
  options: {
    search: string;
    provider: string;
    official: boolean;
    artist: string;
    tag: string;
    dpi: number;
    favorites: boolean;
    sort: string;
  },
  data: Preferences,
): Art[] {
  const unique = [...new Map(items.map((art) => [art.id, art])).values()];
  const text = options.search.toLowerCase().trim();
  return unique
    .filter((art) => {
      const preference = data.preferences[art.id];
      const tags = [...art.tags, ...(preference?.tags ?? [])].map(normalizeTag);
      return (
        (options.official
          ? art.provider === "scryfall"
          : options.provider === "all" || art.provider === options.provider) &&
        (!options.artist ||
          art.artist === options.artist ||
          art.source === options.artist) &&
        (!options.tag || tags.includes(normalizeTag(options.tag))) &&
        art.dpi >= options.dpi &&
        (!options.favorites || preference?.favorite) &&
        `${art.name} ${art.source} ${art.artist} ${art.set} ${art.collectorNumber} ${art.language} ${tags.join(" ")}`
          .toLowerCase()
          .includes(text)
      );
    })
    .sort((a, b) => {
      if (options.sort === "rating")
        return (
          (data.preferences[b.id]?.rating ?? 0) -
            (data.preferences[a.id]?.rating ?? 0) ||
          b.releasedAt.localeCompare(a.releasedAt)
        );
      if (options.sort === "popular")
        return (
          (data.usage[b.id] ?? 0) - (data.usage[a.id] ?? 0) ||
          b.releasedAt.localeCompare(a.releasedAt)
        );
      if (options.sort === "dpi") return b.dpi - a.dpi;
      if (options.sort === "artist") return a.artist.localeCompare(b.artist);
      return options.sort === "oldest"
        ? (a.releasedAt || "9999").localeCompare(b.releasedAt || "9999")
        : b.releasedAt.localeCompare(a.releasedAt);
    });
}

function ArtSession({
  deck,
  entry,
  onSelect,
  onApply,
  face,
  setFace,
  heading,
  onMatchCount,
  onApplied,
}: {
  deck: Deck;
  entry: DeckEntry;
  onSelect: (id: string, face?: number) => void;
  onApply: (deck: Deck) => Promise<Deck>;
  face: number;
  setFace: (face: number) => void;
  heading: React.Ref<HTMLHeadingElement>;
  onMatchCount: (count: number) => void;
  onApplied: (printing: string) => void;
}) {
  const client = useQueryClient();
  const original = entry.card.faces[face] ?? null;
  const savedArt = face === 0 ? frontArt : backArt;
  const saved = savedArt(entry);
  const [candidate, setCandidate] = useState<Art | null>(saved);
  const changed = candidate?.id !== saved?.id;
  const originalIsSaved = original?.id === saved?.id;
  const previewingOriginal = changed && candidate?.id === original?.id;
  const showSavedMonitor = changed && !originalIsSaved;
  const [pendingEntry, setPendingEntry] = useState<string | null>(null);
  const scopeDescription = useId();
  const [provider, setProvider] = useState("all");
  const [official, setOfficial] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");
  const [artist, setArtist] = useState("");
  const [tag, setTag] = useState("");
  const [dpi, setDpi] = useState(0);
  const [favorites, setFavorites] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [scope, setScope] = useState("entry");
  const [upload, setUpload] = useState(false);
  const [styleMatch, setStyleMatch] = useState(false);
  const task = useTask();
  const prefs = useQuery({
    queryKey: ["preferences"],
    queryFn: ({ signal }) => api.preferences(signal),
  });
  const personal = prefs.data ?? { preferences: {}, usage: {} };
  const prints = useInfiniteQuery({
    queryKey: ["art", "scryfall", entry.card.oracleId, face],
    queryFn: ({ pageParam, signal }) =>
      api.art(
        "scryfall",
        entry.card.oracleId,
        entry.card.name,
        face,
        pageParam,
        signal,
      ),
    initialPageParam: 1,
    getNextPageParam: (page) => (page.hasMore ? page.page + 1 : undefined),
    enabled:
      !!original && (official || provider === "all" || provider === "scryfall"),
    staleTime: 86_400_000,
    retry: false,
  });
  const community = useInfiniteQuery({
    queryKey: ["art", "mpc", entry.card.oracleId, face],
    queryFn: ({ pageParam, signal }) =>
      api.art(
        "mpc",
        entry.card.oracleId,
        original?.name ?? entry.card.name,
        face,
        pageParam,
        signal,
      ),
    initialPageParam: 1,
    getNextPageParam: (page) => (page.hasMore ? page.page + 1 : undefined),
    enabled:
      !!original && !official && (provider === "all" || provider === "mpc"),
    staleTime: 86_400_000,
    retry: false,
  });
  const uploads = useQuery({
    queryKey: ["uploads", entry.card.oracleId],
    queryFn: ({ signal }) => api.uploads(entry.card.oracleId, signal),
  });
  const items = [
    ...(original ? [original] : []),
    ...(saved ? [saved] : []),
    ...(candidate ? [candidate] : []),
    ...(prints.data?.pages.flatMap((page) => page.items) ?? []),
    ...(community.data?.pages.flatMap((page) => page.items) ?? []),
    ...(uploads.data ?? []),
  ];
  const shown = filterArt(
    items,
    { search, provider, official, sort, artist, tag, dpi, favorites },
    personal,
  );
  const artists = [
    ...new Set(
      items.flatMap((art) => [
        art.artist,
        ...(art.provider === "mpc" ? [art.source] : []),
      ]),
    ),
  ].sort();
  const tags = [
    ...new Set(
      items
        .flatMap((art) => [
          ...art.tags,
          ...(personal.preferences[art.id]?.tags ?? []),
        ])
        .map(normalizeTag),
    ),
  ].sort();
  const index = deck.entries.findIndex((item) => item.id === entry.id);
  const sameCard = deck.entries.filter(
    (item) => item.card.oracleId === entry.card.oracleId,
  );
  const cardCount = sameCard.reduce((sum, item) => sum + item.quantity, 0);
  const nextEntry = deck.entries[index + 1];
  const previousEntry = deck.entries[index - 1];
  const entryCopies =
    entry.quantity === 1 ? "1 copy" : `${entry.quantity} copies`;
  const impact =
    scope === "deck"
      ? `${entryCopies} here · ${cardCount} copies across all boards`
      : scope === "one" && entry.quantity > 1
        ? `1 of ${entry.quantity} copies in this entry`
        : `${entryCopies} in this entry`;
  const preference = artPreferenceSchema.parse(
    candidate ? (personal.preferences[candidate.id] ?? {}) : {},
  );
  const navigate = (id: string) => {
    if (id === entry.id || task.busy) return;
    if (changed) setPendingEntry(id);
    else onSelect(id);
  };
  const apply = (next: boolean) =>
    void task.run(async () => {
      const selected =
        face === 0
          ? { selectedArt: candidate?.id === original?.id ? null : candidate }
          : { selectedBack: candidate?.id === original?.id ? null : candidate };
      const splitId =
        scope === "one" && entry.quantity > 1 ? crypto.randomUUID() : null;
      const entries = deck.entries.flatMap((item) => {
        if (
          item.id !== entry.id &&
          !(scope === "deck" && item.card.oracleId === entry.card.oracleId)
        )
          return [item];
        if (splitId)
          return [
            { ...item, quantity: item.quantity - 1 },
            { ...item, ...selected, quantity: 1, id: splitId },
          ];
        return [{ ...item, ...selected }];
      });
      const committed = await onApply({ ...deck, entries });
      const appliedEntry = committed.entries.find(
        (item) => item.id === (splitId ?? entry.id),
      );
      if (appliedEntry) {
        const appliedArt = savedArt(appliedEntry);
        setCandidate(appliedArt);
        if (appliedArt?.id !== saved?.id)
          onApplied(
            appliedArt
              ? [appliedArt.source, appliedArt.collectorNumber]
                  .filter(Boolean)
                  .join(" ")
              : "Playtest card back",
          );
      }
      if (next && nextEntry) onSelect(nextEntry.id);
      else if (splitId && appliedEntry) onSelect(splitId, face);
    });
  const savePreference = (change: Partial<typeof preference>) => {
    if (candidate)
      void task.run(async () => {
        await api.savePreference(candidate.id, { ...preference, ...change });
        await client.invalidateQueries({ queryKey: ["preferences"] });
      });
  };
  const showPrints = official || provider === "all" || provider === "scryfall";
  const showCommunity = !official && (provider === "all" || provider === "mpc");
  const loadedPrints =
    prints.data?.pages.reduce((count, page) => count + page.items.length, 0) ??
    0;
  const totalPrints = prints.data?.pages[0]?.total ?? 0;
  const totalCommunity = community.data?.pages[0]?.total ?? 0;
  const fetchingArt =
    (showPrints && prints.isFetching) ||
    (showCommunity && community.isFetching) ||
    uploads.isFetching;
  const matchCount = shown.length;
  useEffect(() => {
    if (fetchingArt) return;
    const timer = window.setTimeout(() => onMatchCount(matchCount), 300);
    return () => window.clearTimeout(timer);
  }, [fetchingArt, matchCount, onMatchCount]);
  return (
    <div className="art-studio">
      <div className="art-studio-scroll">
        <div className="studio-toolbar">
          <div className="heading-group">
            <h2 ref={heading} tabIndex={-1}>
              {original?.name ?? entry.card.name}
            </h2>
            <span className="badge mono">×{entry.quantity}</span>
          </div>
          <div className="segmented">
            <button
              type="button"
              aria-pressed={face === 0}
              onClick={() => setFace(0)}
            >
              Front
            </button>
            <button
              type="button"
              aria-pressed={face === 1}
              onClick={() => setFace(1)}
            >
              Back
            </button>
          </div>
          <div className="spacer" />
          {face === 0 && candidate && deck.entries.length > 1 && (
            <button
              type="button"
              className="icon-button"
              aria-label="Match art style across the deck (beta)"
              title="Match art style across the deck (beta)"
              disabled={task.busy}
              onClick={() => setStyleMatch(true)}
            >
              <Sparkles size={15} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Previous card"
            disabled={!previousEntry || task.busy}
            onClick={() => previousEntry && navigate(previousEntry.id)}
          >
            <ArrowLeft size={15} />
          </button>
          <span className="mono muted">
            {index + 1} / {deck.entries.length}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next card"
            disabled={!nextEntry || task.busy}
            onClick={() => nextEntry && navigate(nextEntry.id)}
          >
            <ArrowRight size={15} />
          </button>
        </div>
        <div className="art-apply-toolbar">
          <div className="spacer" />
          <label className="inline-label">
            Apply to
            <select
              value={scope}
              disabled={task.busy}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="entry">
                {entry.quantity === 1 ? "This copy" : `All ${entryCopies} here`}
              </option>
              {entry.quantity > 1 && <option value="one">One copy only</option>}
              {sameCard.length > 1 && (
                <option value="deck">All {cardCount} across deck</option>
              )}
            </select>
          </label>
          <p className="hint" id={scopeDescription} aria-live="polite">
            {impact}
          </p>
          <button
            type="button"
            disabled={task.busy}
            aria-describedby={scopeDescription}
            onClick={() => apply(false)}
          >
            Apply
          </button>
          <button
            type="button"
            className="primary"
            disabled={task.busy}
            aria-describedby={scopeDescription}
            onClick={() => apply(true)}
          >
            {task.busy
              ? "Saving…"
              : !nextEntry
                ? "Apply & save"
                : "Apply & next"}
            <ArrowRight size={15} />
          </button>
        </div>
        <ErrorNotice error={task.error} />
        {styleMatch && candidate && (
          <StyleMatch
            deck={deck}
            entry={entry}
            reference={candidate}
            onClose={() => setStyleMatch(false)}
            onApply={onApply}
          />
        )}
        <div
          className={
            showSavedMonitor && !previewingOriginal
              ? "comparison comparison-three"
              : "comparison"
          }
        >
          {!previewingOriginal && (
            <Monitor
              label="Original"
              art={original}
              zoom={zoom}
              states={originalIsSaved ? ["Original", "Saved"] : ["Original"]}
            />
          )}
          {showSavedMonitor && (
            <Monitor label="Saved" art={saved} zoom={zoom} states={["Saved"]} />
          )}
          <Monitor
            label="Preview"
            art={candidate}
            zoom={zoom}
            states={
              previewingOriginal
                ? ["Preview", "Original"]
                : !changed && !originalIsSaved
                  ? ["Preview", "Saved"]
                  : ["Preview"]
            }
          >
            <button
              type="button"
              className="icon-button"
              aria-label="Reset to original art"
              title="Reset to original art"
              disabled={candidate?.id === original?.id}
              onClick={() => setCandidate(original)}
            >
              <RotateCcw size={14} />
            </button>
          </Monitor>
        </div>
        <div className="comparison-controls">
          <label className="inline-label">
            <ZoomIn size={15} />
            Linked zoom
            <input
              type="range"
              min="1"
              max="2.5"
              step="0.25"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
            <span className="mono">{Math.round(zoom * 100)}%</span>
          </label>
          <span className="hint">
            Original scans stay untouched. Scroll inside either monitor to
            inspect details.
          </span>
          <div className="spacer" />
          {candidate && (
            <>
              <button
                type="button"
                className={preference.favorite ? "favorite active" : "favorite"}
                aria-pressed={preference.favorite}
                disabled={task.busy}
                onClick={() =>
                  savePreference({ favorite: !preference.favorite })
                }
              >
                <Heart
                  size={15}
                  fill={preference.favorite ? "currentColor" : "none"}
                />
                Favorite
              </button>
              <label className="inline-label">
                Your rating
                <select
                  aria-label="Your rating"
                  value={preference.rating}
                  disabled={task.busy}
                  onChange={(event) =>
                    savePreference({ rating: Number(event.target.value) })
                  }
                >
                  <option value={0}>Unrated</option>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option value={value} key={value}>
                      {value} / 5
                    </option>
                  ))}
                </select>
              </label>
              <PersonalTags
                key={candidate.id}
                value={preference.tags}
                disabled={task.busy}
                save={(value) => savePreference({ tags: value })}
              />
            </>
          )}
        </div>
        <section className="art-browser">
          <div className="section-heading">
            <h3>Find your edition</h3>
            <span className="hint">
              Ratings and popularity are from your local library, not community
              votes.
            </span>
          </div>
          <div className="toolbar">
            <SearchField
              value={search}
              onChange={setSearch}
              label="Search set, artist, creator or tag"
            />
            <div className="segmented provider-tabs">
              {[
                ["all", "All"],
                ["scryfall", "Scryfall"],
                ["mpc", "MPC Autofill"],
                ["upload", "My uploads"],
              ].map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={provider === value && !official}
                  onClick={() => {
                    setProvider(value ?? "all");
                    setOfficial(false);
                    setArtist("");
                    setTag("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="check-label official-toggle">
              <input
                type="checkbox"
                checked={official}
                onChange={(event) => setOfficial(event.target.checked)}
              />
              Official only
            </label>
            <button
              type="button"
              className="icon-button"
              aria-label="Upload your own art"
              title="Upload your own art"
              onClick={() => setUpload(true)}
            >
              <Upload size={15} />
            </button>
          </div>
          <div className="toolbar filter-toolbar">
            <label className="inline-label">
              Sort
              <select
                aria-label="Sort art"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="rating">Your highest rated</option>
                <option value="popular">Popular in your decks</option>
                <option value="dpi">Highest resolution</option>
                <option value="artist">Artist A–Z</option>
              </select>
            </label>
            <select
              aria-label="Filter artist or creator"
              value={artist}
              onChange={(event) => setArtist(event.target.value)}
            >
              <option value="">Any artist / creator</option>
              {artists.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <select
              aria-label="Filter art tag"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            >
              <option value="">Any tag</option>
              {tags.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <select
              aria-label="Minimum art DPI"
              value={dpi}
              onChange={(event) => setDpi(Number(event.target.value))}
            >
              <option value={0}>Any resolution</option>
              <option value={600}>600+ DPI</option>
              <option value={1200}>1200+ DPI</option>
            </select>
            <button
              type="button"
              className={favorites ? "chip active" : "chip"}
              aria-pressed={favorites}
              onClick={() => setFavorites(!favorites)}
            >
              <Heart size={13} />
              Favorites
            </button>
            <div className="spacer" />
            <span className="hint">
              {matchSummary(matchCount)}
              {showPrints && loadedPrints < totalPrints && (
                <>
                  {" "}
                  · {loadedPrints} of {totalPrints} Scryfall prints loaded
                </>
              )}
            </span>
          </div>
          <ErrorNotice error={prefs.error} retry={() => void prefs.refetch()} />
          {showPrints && (
            <ErrorNotice
              error={prints.error}
              retry={() => void prints.refetch()}
            />
          )}
          {showCommunity && (
            <ErrorNotice
              error={community.error}
              retry={() => void community.refetch()}
            />
          )}
          <ErrorNotice
            error={uploads.error}
            retry={() => void uploads.refetch()}
          />
          {((showPrints && prints.isFetching && !prints.data) ||
            (showCommunity && community.isFetching && !community.data)) && (
            <Loading>Finding editions…</Loading>
          )}
          <div className="art-grid">
            {shown.map((art) => {
              const states: ArtState[] = [];
              if (art.id === saved?.id) states.push("Saved");
              if (art.id === candidate?.id) states.push("Preview");
              if (art.id === original?.id) states.push("Original");
              return (
                <button
                  type="button"
                  className={`art-option ${candidate?.id === art.id ? "selected" : ""}`}
                  key={art.id}
                  aria-label={`Select ${art.source} ${art.collectorNumber} by ${art.artist}${states.length ? ` — ${states.join(", ")}` : ""}`}
                  aria-pressed={candidate?.id === art.id}
                  onClick={() => setCandidate(art)}
                >
                  <span className="art-option-image">
                    <CardImage
                      url={art.thumbnailUrl}
                      name={`${art.name}, ${art.source}`}
                    />
                    {personal.preferences[art.id]?.favorite && (
                      <Heart
                        className="image-heart"
                        size={15}
                        fill="currentColor"
                      />
                    )}
                  </span>
                  <ArtStates states={states} />
                  <strong>
                    {art.source}
                    {art.collectorNumber ? ` · ${art.collectorNumber}` : ""}
                  </strong>
                  <span className="muted truncate">{art.artist}</span>
                  <div className="art-option-meta">
                    <span
                      className={`badge ${art.provider === "scryfall" ? "official" : ""}`}
                    >
                      {art.provider === "scryfall"
                        ? "Official"
                        : art.provider === "mpc"
                          ? "Community"
                          : "Upload"}
                    </span>
                    <span className="mono muted">{art.dpi} dpi</span>
                  </div>
                  {personal.preferences[art.id]?.rating ? (
                    <small className="accent">
                      Your rating {personal.preferences[art.id]?.rating}/5
                    </small>
                  ) : null}
                </button>
              );
            })}
          </div>
          {!shown.length && !prints.isFetching && !community.isFetching && (
            <div className="empty-state">
              <h3>No matching art</h3>
              <p>
                Clear a filter, load more results, or upload an image for this{" "}
                {face ? "back" : "front"}.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setArtist("");
                  setTag("");
                  setDpi(0);
                  setFavorites(false);
                }}
              >
                Clear filters
              </button>
            </div>
          )}
          <div className="load-more">
            {showPrints && prints.hasNextPage && (
              <button
                type="button"
                disabled={prints.isFetching}
                onClick={() => void prints.fetchNextPage()}
              >
                Load more Scryfall prints
                {totalPrints > 0 && ` · ${totalPrints} total`}
              </button>
            )}
            {showCommunity && community.hasNextPage && (
              <button
                type="button"
                disabled={community.isFetching}
                onClick={() => void community.fetchNextPage()}
              >
                Load more MPC art
                {totalCommunity > 0 && ` · ${totalCommunity} total`}
              </button>
            )}
            <span className="hint">
              Filters and sorting apply to loaded results. MPC creators are not
              necessarily the original artists.
            </span>
          </div>
        </section>
      </div>
      <nav className="filmstrip" aria-label="Deck card navigator">
        {deck.entries.map((item, i) => (
          <button
            type="button"
            key={item.id}
            aria-label={`Edit art ${i + 1}: ${item.card.name}`}
            aria-current={item.id === entry.id ? "true" : undefined}
            disabled={task.busy}
            onClick={() => navigate(item.id)}
          >
            <CardImage url={frontArt(item).thumbnailUrl} name="" />
            <span>{item.card.name}</span>
            <small>×{item.quantity}</small>
          </button>
        ))}
      </nav>
      {pendingEntry && (
        <DiscardPreview
          onStay={() => setPendingEntry(null)}
          onDiscard={() => {
            setPendingEntry(null);
            onSelect(pendingEntry);
          }}
        />
      )}
      {upload && (
        <UploadArt
          entry={entry}
          onClose={() => setUpload(false)}
          onUploaded={(art) => {
            setCandidate(art);
            setProvider("upload");
            setOfficial(false);
            setUpload(false);
            void client.invalidateQueries({
              queryKey: ["uploads", entry.card.oracleId],
            });
          }}
        />
      )}
    </div>
  );
}

function DiscardPreview({
  onStay,
  onDiscard,
}: {
  onStay: () => void;
  onDiscard: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const stay = () => {
    dialogRef.current?.close();
    onStay();
  };
  return (
    <dialog
      className="modal"
      ref={dialogRef}
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(event) => {
        event.preventDefault();
        stay();
      }}
    >
      <div className="modal-heading">
        <h2 id={title}>Discard art preview?</h2>
      </div>
      <p id={description}>
        This preview hasn’t been applied. Discard it to move to another card.
        Your saved art won’t change.
      </p>
      <div className="modal-actions">
        <button type="button" className="primary" onClick={stay}>
          Stay
        </button>
        <button
          type="button"
          onClick={() => {
            dialogRef.current?.close();
            onDiscard();
          }}
        >
          Discard
        </button>
      </div>
    </dialog>
  );
}

type ArtState = "Original" | "Saved" | "Preview";

function ArtStates({ states }: { states: ArtState[] }) {
  if (!states.length) return null;
  return (
    <span className="art-states">
      {states.map((state) => (
        <span className="art-state" data-state={state} key={state}>
          {state}
        </span>
      ))}
    </span>
  );
}

function Monitor({
  label,
  art,
  zoom,
  states,
  children,
}: {
  label: ArtState;
  art: Art | null;
  zoom: number;
  states: ArtState[];
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-label={`${label} art`}
      className={`monitor ${label === "Preview" ? "selected-monitor" : ""}`}
    >
      <div className="monitor-heading">
        <ArtStates states={states} />
        <span
          className={`badge ${art?.provider === "scryfall" ? "official" : ""}`}
        >
          {art ? providerName(art) : "Deckpress back"}
        </span>
      </div>
      <div className="monitor-body">
        <div className="monitor-picture">
          <div style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}>
            {art ? (
              <CardImage
                url={art.imageUrl}
                name={`${label}: ${art.name}`}
                eager
              />
            ) : (
              <div className="default-back">
                <span>DP</span>
                <strong>DECKPRESS</strong>
                <small>PLAYTEST CARD</small>
              </div>
            )}
          </div>
        </div>
        <div className="monitor-details">
          <h3>{art?.source ?? "Playtest card back"}</h3>
          <span className="mono muted">
            {art?.set.toUpperCase()}
            {art?.collectorNumber ? ` · #${art.collectorNumber}` : ""}
          </span>
          <dl>
            <div>
              <dt>Artist</dt>
              <dd>{art?.artist ?? "Deckpress"}</dd>
            </div>
            <div>
              <dt>Language</dt>
              <dd>{art?.language.toUpperCase() ?? "EN"}</dd>
            </div>
            <div>
              <dt>Source resolution</dt>
              <dd className="mono">{art ? `~${art.dpi} dpi` : "Vector"}</dd>
            </div>
            <div>
              <dt>Existing bleed</dt>
              <dd className="mono">{art?.bleedMm ?? 0} mm</dd>
            </div>
            <div>
              <dt>Style</dt>
              <dd>{art?.tags.join(", ") || "Standard"}</dd>
            </div>
          </dl>
          <div className="monitor-actions">
            {children}
            {art?.sourceUrl && (
              <ExternalLink href={art.sourceUrl}>
                Open source
                <LinkIcon size={12} />
              </ExternalLink>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PersonalTags({
  value,
  save,
  disabled,
}: {
  value: string[];
  save: (tags: string[]) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(value.join(", "));
  return (
    <form
      className="personal-tags"
      onSubmit={(event) => {
        event.preventDefault();
        save([
          ...new Set(
            text
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ]);
      }}
    >
      <input
        aria-label="Your art labels"
        placeholder="Your labels, comma separated"
        value={text}
        maxLength={400}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" disabled={disabled}>
        Save labels
      </button>
    </form>
  );
}

function UploadArt({
  entry,
  onClose,
  onUploaded,
}: {
  entry: DeckEntry;
  onClose: () => void;
  onUploaded: (art: Art) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [artist, setArtist] = useState("");
  const [bleed, setBleed] = useState("auto");
  const [customBleed, setCustomBleed] = useState("");
  const task = useTask();
  return (
    <Modal title="Upload card art" onClose={onClose} busy={task.busy}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (file)
            void task.run(async () => {
              if (file.size > 16 * 1024 * 1024)
                throw new Error("Image exceeds 16 MB");
              onUploaded(
                await api.upload(file, {
                  oracleId: entry.card.oracleId,
                  name: entry.card.name,
                  artist,
                  ...(bleed === "auto"
                    ? {}
                    : {
                        bleedMm: Number(
                          bleed === "custom" ? customBleed : bleed,
                        ),
                      }),
                }),
              );
            });
        }}
      >
        <p className="muted">
          Upload a full card image, including the frame and text. Files stay on
          this machine.
        </p>
        <label className="field">
          Image · PNG, JPEG or WebP
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            required
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <label className="field">
          Artist / credit
          <input
            maxLength={200}
            value={artist}
            onChange={(event) => setArtist(event.target.value)}
            placeholder="Credit the original artist"
          />
        </label>
        <label className="field">
          Existing bleed per side
          <select
            value={bleed}
            onChange={(event) => setBleed(event.target.value)}
          >
            <option value="auto">Auto-detect (recommended)</option>
            <option value={0}>No bleed, trimmed card</option>
            <option value={3.048}>MPC image, 36 px at 300 DPI</option>
            <option value={3.175}>⅛ inch bleed</option>
            <option value="custom">Custom bleed</option>
          </select>
        </label>
        {bleed === "custom" && (
          <label className="field">
            Custom bleed per side (mm)
            <input
              type="number"
              min={0}
              max={10}
              step="any"
              required
              value={customBleed}
              onChange={(event) => setCustomBleed(event.target.value)}
            />
          </label>
        )}
        <p className="hint">
          Auto-detect uses image proportions to match common bleed sizes.
          Override it if you already know the bleed. Existing bleed is removed
          before applying your print settings.
        </p>
        <ErrorNotice error={task.error} />
        <div className="modal-actions">
          <button
            type="submit"
            className="primary"
            disabled={!file || task.busy}
          >
            {task.busy ? "Uploading…" : "Upload & preview"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
