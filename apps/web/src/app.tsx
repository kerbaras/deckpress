import { useQuery } from "@tanstack/react-query";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Compass,
  Download,
  FolderOpen,
  HardDrive,
  Images,
  Layers3,
  ExternalLink as LinkIcon,
  Plus,
  Printer,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, confirmAction, fetchHealth, type ModelStatus } from "./api.ts";
import { DeckSearch } from "./deck-search.tsx";
import { Library } from "./library.tsx";
import {
  PageToolbar,
  SidebarToggle,
  TitleBar,
  ToolbarSlotProvider,
  useWindowState,
} from "./titlebar.tsx";
import {
  ErrorNotice,
  ExternalLink,
  Loading,
  prettyDate,
  useTask,
} from "./ui.tsx";
import { Workspace } from "./workspace.tsx";

const routeFromHash = () =>
  window.location.hash.replace(/^#\/?/, "") || "decks";

const library = [
  { id: "decks", name: "Decks", icon: Layers3 },
  { id: "jobs", name: "Print jobs", icon: Printer },
  { id: "sources", name: "Art sources", icon: Images },
  { id: "discover", name: "Discover", icon: Compass },
];
const RECENT_DECKS = 6;
const SIDEBAR_KEY = "deckpress.sidebar";
const confirmDiscard = () =>
  confirmAction(
    "Leave this deck and discard unsaved changes?",
    "Discard changes",
  );
const deckRoute = (route: string) => /^decks\/([\da-f-]{36})$/.exec(route)?.[1];

function readSidebar(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebar);
  const [newDeckRequest, setNewDeckRequest] = useState(0);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const window_ = useWindowState();
  const routeRef = useRef(route);
  const dirty = useRef(false);
  const onDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 30_000,
  });
  const decks = useQuery({
    queryKey: ["decks"],
    queryFn: ({ signal }) => api.decks(signal),
  });
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: ({ signal }) => api.jobs(signal),
    refetchInterval: 4000,
    retry: false,
  });
  const activeJobs =
    jobs.data?.filter((job) => ["queued", "running"].includes(job.status))
      .length ?? 0;
  const navigate = async (next: string, saved = false) => {
    if (!saved && dirty.current && !(await confirmDiscard())) return false;
    dirty.current = false;
    window.location.hash = `/${next}`;
    return true;
  };
  useEffect(() => {
    const change = async () => {
      const next = routeFromHash();
      if (next === routeRef.current) return;
      if (dirty.current) {
        window.history.replaceState(null, "", `#/${routeRef.current}`);
        if (!(await confirmDiscard())) return;
        dirty.current = false;
        window.location.hash = `/${next}`;
        return;
      }
      routeRef.current = next;
      setRoute(next);
      const main = document.getElementById("main");
      if (main) main.scrollTop = 0;
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    const onChange = () => void change();
    window.addEventListener("hashchange", onChange);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, open ? "closed" : "open");
      } catch {
        // Private mode or a full disk; the toggle still works for now.
      }
      return !open;
    });
  }, []);
  const newDeck = async () => {
    if (await navigate("decks")) setNewDeckRequest((count) => count + 1);
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;
      const key = event.key.toLowerCase();
      if (key === "b") toggleSidebar();
      else if (key === "n") void newDeck();
      else if (key === ",") void navigate("settings");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  const deckId = deckRoute(route);
  const recent = (decks.data ?? [])
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_DECKS);
  const modifier = window_.platform === "macos" ? "⌘" : "Ctrl+";
  return (
    <div
      className="app-shell"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-platform={window_.platform}
      data-focused={window_.focused}
      style={{
        ["--inset-left" as string]: `${window_.fullscreen ? 0 : window_.insetLeft}px`,
      }}
    >
      <button
        type="button"
        className="skip-link"
        onClick={() => document.getElementById("main")?.focus()}
      >
        Skip to content
      </button>
      <aside className="sidebar" aria-hidden={!sidebarOpen}>
        <div className="sidebar-head" data-tauri-drag-region>
          <SidebarToggle
            open
            platform={window_.platform}
            onToggle={toggleSidebar}
          />
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <button
            type="button"
            className="sidebar-row sidebar-action"
            aria-keyshortcuts="Control+N Meta+N"
            title={`New deck (${modifier}N)`}
            onClick={() => void newDeck()}
          >
            <Plus size={16} aria-hidden="true" />
            <span className="sidebar-label">New deck</span>
          </button>
          <h2 className="sidebar-heading" id="sidebar-library">
            Library
          </h2>
          <section className="sidebar-group" aria-labelledby="sidebar-library">
            {library.map(({ id, name, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className="sidebar-row"
                title={name}
                aria-current={
                  !deckId && route.startsWith(id) ? "page" : undefined
                }
                data-ancestor={deckId && id === "decks" ? "true" : undefined}
                onClick={() => void navigate(id)}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="sidebar-label">{name}</span>
                {id === "jobs" && activeJobs > 0 && (
                  <span className="sidebar-count">
                    {activeJobs}
                    <span className="sr-only"> in progress</span>
                  </span>
                )}
              </button>
            ))}
          </section>
          {recent.length > 0 && (
            <>
              <h2 className="sidebar-heading" id="sidebar-recent">
                Recent decks
              </h2>
              <section
                className="sidebar-group"
                aria-labelledby="sidebar-recent"
              >
                {recent.map((deck) => (
                  <button
                    type="button"
                    key={deck.id}
                    className="sidebar-row sidebar-nested"
                    title={`${deck.name} · ${deck.format}`}
                    aria-current={deck.id === deckId ? "page" : undefined}
                    onClick={() => void navigate(`decks/${deck.id}`)}
                  >
                    <span className="sidebar-label">{deck.name}</span>
                  </button>
                ))}
              </section>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          {health.isError && (
            <button
              type="button"
              className="sidebar-row sidebar-alert"
              title="The print engine did not start. Click to retry."
              onClick={() => void health.refetch()}
            >
              <AlertTriangle size={16} aria-hidden="true" />
              <span className="sidebar-label">Engine not running</span>
            </button>
          )}
          <button
            type="button"
            className="sidebar-row"
            title={`Settings (${modifier},)`}
            aria-keyshortcuts="Control+, Meta+,"
            aria-current={route.startsWith("settings") ? "page" : undefined}
            onClick={() => void navigate("settings")}
          >
            <Settings2 size={16} aria-hidden="true" />
            <span className="sidebar-label">Settings</span>
          </button>
        </div>
      </aside>
      <div className="app-content">
        <TitleBar
          state={window_}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          onSlot={setSlot}
        />
        <main id="main" className="main-content" tabIndex={-1}>
          <ToolbarSlotProvider value={slot}>
            {deckId ? (
              <Workspace
                key={deckId}
                id={deckId}
                onDirty={onDirty}
                onBack={() => void navigate("decks")}
                onJobs={() => void navigate("jobs", true)}
              />
            ) : route === "jobs" ? (
              <PrintJobs active={activeJobs} />
            ) : route === "settings" ? (
              <LocalSettings />
            ) : route === "sources" ? (
              <Sources />
            ) : route === "discover" ? (
              <DeckSearch open={(id) => void navigate(`decks/${id}`)} />
            ) : (
              <Library
                open={(id) => void navigate(`decks/${id}`)}
                createRequest={newDeckRequest}
                onCreateHandled={() => setNewDeckRequest(0)}
              />
            )}
          </ToolbarSlotProvider>
        </main>
      </div>
    </div>
  );
}

function PrintJobs({ active }: { active: number }) {
  const query = useQuery({
    queryKey: ["jobs"],
    queryFn: ({ signal }) => api.jobs(signal),
    staleTime: 0,
    refetchInterval: (state) =>
      state.state.data?.some((job) =>
        ["queued", "running"].includes(job.status),
      )
        ? 1000
        : false,
  });
  const task = useTask();
  const total = query.data?.length ?? 0;
  return (
    <>
      <PageToolbar
        title="Print jobs"
        subtitle={
          active
            ? `${active} in progress`
            : total
              ? `${total} ${total === 1 ? "export" : "exports"}`
              : undefined
        }
      >
        <button
          type="button"
          className="icon-button quiet"
          aria-label="Refresh print jobs"
          title="Refresh"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} />
        </button>
      </PageToolbar>
      <div className="page-content">
        <ErrorNotice
          error={query.error ?? task.error}
          retry={() => void query.refetch()}
        />
        {query.isPending ? (
          <Loading>Loading print jobs…</Loading>
        ) : !query.data?.length ? (
          <div className="empty-state">
            <Printer size={38} />
            <h2>No print jobs yet</h2>
            <p>Open a deck, choose Print setup, then generate a PDF.</p>
          </div>
        ) : (
          <div className="jobs-list">
            {query.data.map((job) => (
              <article className="panel job" key={job.id}>
                <span className={`job-symbol ${job.status}`}>
                  <Printer size={24} />
                </span>
                <div className="job-body">
                  <div className="section-heading">
                    <h2>{job.deckName}</h2>
                    <span className={`badge status-${job.status}`}>
                      {job.status}
                    </span>
                  </div>
                  <p className="mono muted">{job.fileName}</p>
                  <p role={job.status === "running" ? "status" : undefined}>
                    {job.message}
                  </p>
                  {["queued", "running"].includes(job.status) && (
                    <progress
                      aria-label={`Export progress for ${job.deckName}`}
                      value={job.completed}
                      max={job.total || 1}
                    />
                  )}
                  <div className="job-meta">
                    <span>{prettyDate(job.createdAt)}</span>
                    <span>{job.pages} PDF pages</span>
                    {job.bytes > 0 && (
                      <span>{(job.bytes / 1024 / 1024).toFixed(1)} MB</span>
                    )}
                    <span>
                      {job.completed} / {job.total} faces
                    </span>
                  </div>
                </div>
                <div className="job-actions">
                  {job.status === "completed" ? (
                    <>
                      <button
                        type="button"
                        className="primary"
                        disabled={task.busy}
                        onClick={() => void task.run(() => api.openPdf(job.id))}
                      >
                        <Printer size={16} />
                        Open PDF
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Save a copy"
                        title="Save a copy…"
                        disabled={task.busy}
                        onClick={() =>
                          void task.run(async () => {
                            const destination = await save({
                              defaultPath: job.fileName,
                              filters: [{ name: "PDF", extensions: ["pdf"] }],
                            });
                            if (destination)
                              await api.savePdf(job.id, destination);
                          })
                        }
                      >
                        <Download size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Show in folder"
                        title="Show in folder"
                        disabled={task.busy}
                        onClick={() =>
                          void task.run(() => api.revealPdf(job.id))
                        }
                      >
                        <FolderOpen size={16} />
                      </button>
                    </>
                  ) : ["queued", "running"].includes(job.status) ? (
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label="Cancel export"
                      title="Cancel export"
                      disabled={task.busy}
                      onClick={() =>
                        void task.run(async () => {
                          await api.cancelJob(job.id);
                          await query.refetch();
                        })
                      }
                    >
                      <X size={15} />
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
        <div className="notice print-job-note">
          <Printer size={19} />
          <span>
            Print at <strong>100% / actual size</strong>. Disable “Fit to page”
            and check the calibration page’s 100 mm ruler before the full run.
            For AI exports, inspect rules text and mana symbols.
          </span>
        </div>
      </div>
    </>
  );
}

function LocalSettings() {
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.settings(signal),
  });
  const task = useTask();
  const loaded = query.data?.loaded;
  return (
    <>
      <PageToolbar title="Settings">
        <button
          type="button"
          className="icon-button quiet"
          aria-label="Open data folder"
          title="Open data folder"
          disabled={task.busy}
          onClick={() => void task.run(() => api.openDataDir())}
        >
          <FolderOpen size={16} />
        </button>
      </PageToolbar>
      <div className="page-content settings-page">
        <ErrorNotice
          error={query.error ?? task.error}
          retry={() => void query.refetch()}
        />
        <section className="panel settings-card">
          <div className="section-heading">
            <h2>Local AI upscaling</h2>
            <span className={`badge ${loaded ? "official" : ""}`}>
              {loaded
                ? `Loaded · ${loaded.executionProvider}`
                : "Loads on first export"}
            </span>
          </div>
          <p>
            Real-ESRGAN models run through ONNX Runtime inside the app: Core ML
            on macOS, DirectML on Windows, CUDA or CPU on Linux. Every model
            upscales 4× in 256 px tiles with feathered seams, then the result is
            resized to your target DPI. Fine lettering can change, so always
            check a proof.
          </p>
          <div className="model-list">
            {(query.data?.models ?? []).map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                isDefault={model.id === query.data?.defaultModel}
                loaded={loaded?.modelId === model.id}
                busy={task.busy}
                onDownload={() =>
                  void task.run(async () => {
                    await api.downloadModel(model.id);
                    await query.refetch();
                  })
                }
                onLoad={() =>
                  void task.run(async () => {
                    await api.loadModel(model.id);
                    await query.refetch();
                  })
                }
              />
            ))}
          </div>
          <p className="hint">
            The compact and fast models ship with the app. The quality model is
            downloaded once on request and verified by SHA-256 before it is
            loaded. Without a GPU the quality model is roughly ten times slower
            than the compact one.
          </p>
          {query.data?.styleModel && (
            <div className="model-row">
              <div>
                <strong>{query.data.styleModel.name}</strong>
                <span className="muted">
                  {" · beta · "}
                  {(query.data.styleModel.bytes / 1024 / 1024).toFixed(1)} MB ·{" "}
                  {query.data.styleModel.license}
                  {query.data.styleModel.installed ? "" : " · missing"}
                </span>
                <p className="hint">{query.data.styleModel.description}</p>
              </div>
            </div>
          )}
          <div className="toolbar">
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh model status"
              title="Refresh status"
              onClick={() => void query.refetch()}
            >
              <RefreshCw size={15} />
            </button>
            <ExternalLink href="https://github.com/xinntao/Real-ESRGAN">
              Real-ESRGAN & license
              <LinkIcon size={13} />
            </ExternalLink>
          </div>
        </section>
        <section className="panel settings-card">
          <h2>Storage & portability</h2>
          <p>
            Decks, personal ratings and labels live in local SQLite. Images,
            upscaled results and PDFs are cached on disk in the application data
            directory.
          </p>
          <p className="mono hint">{query.data?.dataDir}</p>
          <p>
            Use “Back up deck” to export a JSON project. It preserves
            quantities, art choices and print settings, but not image files.
            Custom uploads remain on this machine; keep the data directory when
            moving your library.
          </p>
          <div className="toolbar">
            <button
              type="button"
              onClick={() => void task.run(() => api.openDataDir())}
            >
              <FolderOpen size={15} />
              Open data folder
            </button>
          </div>
          <p className="hint">
            Deckpress is a single-user desktop application. Nothing listens on
            the network; only Scryfall and MPC are contacted, and only to fetch
            card data and images.
          </p>
        </section>
        <section className="panel settings-card">
          <h2>Resolution and DPI</h2>
          <p>
            A typical Scryfall PNG is about 745 × 1040 pixels, roughly 300 DPI
            at card size. Setting 1200 DPI alone resamples those pixels. AI
            upscaling estimates detail; it cannot recover an original
            high-resolution scan.
          </p>
          <p>
            Use 300 DPI for proofs and 800 DPI for most home printing. Use 1200
            DPI when your print shop requests it. High-resolution MPC images may
            already meet the target without AI.
          </p>
        </section>
      </div>
    </>
  );
}

function ModelRow({
  model,
  isDefault,
  loaded,
  busy,
  onDownload,
  onLoad,
}: {
  model: ModelStatus;
  isDefault: boolean;
  loaded: boolean;
  busy: boolean;
  onDownload: () => void;
  onLoad: () => void;
}) {
  return (
    <div className="model-row">
      <div>
        <strong>{model.name}</strong>
        <span className="muted">
          {" · "}
          {model.tier}
          {isDefault ? " · default" : ""}
          {" · "}
          {(model.bytes / 1024 / 1024).toFixed(1)} MB · {model.license}
        </span>
        <p className="hint">{model.description}</p>
      </div>
      <div className="toolbar">
        {model.installed ? (
          <button type="button" disabled={busy || loaded} onClick={onLoad}>
            {loaded ? "Loaded" : "Load now"}
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy || model.downloading}
            onClick={onDownload}
          >
            <Download size={15} />
            {model.downloading ? "Downloading…" : "Download"}
          </button>
        )}
      </div>
    </div>
  );
}

function Sources() {
  return (
    <>
      <PageToolbar title="Art sources" />
      <div className="page-content sources-page">
        <div className="source-intro">
          <h2>Where card images come from</h2>
          <p>
            Select a card in Art studio to browse these sources side by side.
            The original printing always stays on the left.
          </p>
        </div>
        <div className="source-list">
          <section className="panel source-card">
            <ShieldCheck size={27} />
            <div>
              <span className="badge official">Official printings</span>
              <h2>Scryfall</h2>
              <p>
                Original scans, set variants, showcase frames, artist credits
                and double-faced cards. Requests are batched, rate-limited and
                cached for 24 hours.
              </p>
              <p className="hint">
                Use “Official only” to show Scryfall provenance. A community
                upload is not treated as official just because it resembles a
                scan.
              </p>
              <ExternalLink href="https://scryfall.com/docs/api">
                Scryfall API
                <LinkIcon size={13} />
              </ExternalLink>
            </div>
          </section>
          <section className="panel source-card">
            <Images size={27} />
            <div>
              <span className="badge">Community art</span>
              <h2>MPC Autofill</h2>
              <p>
                Community editions and high-resolution renders from indexed
                creator drives. Search by card, then narrow by creator, label or
                source resolution.
              </p>
              <p className="hint">
                MPC's public interface is unofficial and can change. Google
                Drive may rate-limit downloads. Creator names identify the
                source drive, not necessarily the artist.
              </p>
              <ExternalLink href="https://mpcfill.com">
                MPC Autofill
                <LinkIcon size={13} />
              </ExternalLink>
            </div>
          </section>
          <section className="panel source-card">
            <HardDrive size={27} />
            <div>
              <span className="badge">Private to your machine</span>
              <h2>Your uploads</h2>
              <p>
                Use your own full-card PNG, JPEG or WebP images. Credit the
                artist and specify whether the file already includes bleed.
                Assign uploads to fronts or backs.
              </p>
              <p className="hint">
                Up to 16 MB per upload. Deck backups store references, not
                uploaded image files.
              </p>
            </div>
          </section>
        </div>
        <p className="legal-note">
          Deckpress is an independent playtest tool, not affiliated with Wizards
          of the Coast, Scryfall or MPC Autofill. Magic: The Gathering and card
          artwork belong to their respective owners. Respect creators and source
          terms.
        </p>
      </div>
    </>
  );
}
