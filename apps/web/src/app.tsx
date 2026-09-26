import { useQuery } from "@tanstack/react-query";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ArrowRight,
  Download,
  FolderOpen,
  HardDrive,
  Images,
  Layers3,
  ExternalLink as LinkIcon,
  Printer,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fetchHealth, type ModelStatus } from "./api.ts";
import { Library } from "./library.tsx";
import { type Crumb, TitleBar } from "./titlebar.tsx";
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

const sections = [
  { id: "decks", name: "Decks", icon: Layers3 },
  { id: "sources", name: "Art sources", icon: Images },
  { id: "jobs", name: "Print jobs", icon: Printer },
  { id: "settings", name: "Settings", icon: Settings2 },
];

const SIDEBAR_KEY = "deckpress.sidebar";

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
  const navigate = (next: string, saved = false) => {
    if (
      !saved &&
      dirty.current &&
      !window.confirm("Leave this deck and discard unsaved changes?")
    )
      return false;
    dirty.current = false;
    window.location.hash = `/${next}`;
    return true;
  };
  useEffect(() => {
    const change = () => {
      const next = routeFromHash();
      if (next === routeRef.current) return;
      if (
        dirty.current &&
        !window.confirm("Leave this deck and discard unsaved changes?")
      ) {
        window.history.replaceState(null, "", `#/${routeRef.current}`);
        return;
      }
      dirty.current = false;
      routeRef.current = next;
      setRoute(next);
      const main = document.getElementById("main");
      if (main) main.scrollTop = 0;
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    window.addEventListener("hashchange", change);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("hashchange", change);
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
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [toggleSidebar]);
  const deckId = /^decks\/([\da-f-]{36})$/.exec(route)?.[1];
  const openDeck = useQuery({
    queryKey: ["deck", deckId],
    queryFn: ({ signal }) => api.deck(deckId as string, signal),
    enabled: !!deckId,
  });
  const section =
    sections.find((item) => route.startsWith(item.id)) ?? sections[0];
  const crumbs: Crumb[] = deckId
    ? [
        { name: "Decks", route: "decks" },
        { name: openDeck.data?.name ?? "Deck" },
      ]
    : section && section.id !== "decks"
      ? [{ name: "Decks", route: "decks" }, { name: section.name }]
      : [{ name: "Decks" }];
  const newDeck = () => {
    if (navigate("decks")) setNewDeckRequest((count) => count + 1);
  };
  const engine = health.isPending
    ? "Starting the local engine"
    : health.isError
      ? "Local engine unavailable. Click to retry."
      : "Local engine running. Everything is saved on this machine.";
  return (
    <div className="app-shell" data-sidebar={sidebarOpen ? "open" : "closed"}>
      <button
        type="button"
        className="skip-link"
        onClick={() => document.getElementById("main")?.focus()}
      >
        Skip to content
      </button>
      <TitleBar
        crumbs={crumbs}
        route={route}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        onNavigate={navigate}
        onNewDeck={newDeck}
      />
      <div className="app-body">
        <aside className="sidebar" aria-hidden={!sidebarOpen}>
          <nav aria-label="Main navigation">
            {sections.map(({ id, name, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-label={name}
                title={name}
                aria-current={route.startsWith(id) ? "page" : undefined}
                onClick={() => navigate(id)}
              >
                <Icon size={17} />
                <span>{name}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button
              type="button"
              className="connection"
              title={engine}
              aria-label={engine}
              onClick={() => void health.refetch()}
            >
              <span
                className={`status-dot ${health.isError ? "offline" : ""}`}
              />
              <HardDrive size={13} aria-hidden="true" />
              <span>
                {health.isPending
                  ? "Starting…"
                  : health.isError
                    ? "Engine unavailable"
                    : "Local, no cloud"}
              </span>
            </button>
          </div>
        </aside>
        <main id="main" className="main-content" tabIndex={-1}>
          {deckId ? (
            <Workspace
              key={deckId}
              id={deckId}
              onDirty={onDirty}
              onBack={() => navigate("decks")}
              onJobs={() => navigate("jobs", true)}
            />
          ) : route === "jobs" ? (
            <PrintJobs />
          ) : route === "settings" ? (
            <LocalSettings />
          ) : route === "sources" ? (
            <Sources onDecks={() => navigate("decks")} />
          ) : (
            <Library
              open={(id) => navigate(`decks/${id}`)}
              createRequest={newDeckRequest}
              onCreateHandled={() => setNewDeckRequest(0)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function PrintJobs() {
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
  return (
    <>
      <header className="page-header">
        <h1>Print jobs</h1>
        <div className="spacer" />
        <span className="muted">Processed on this machine</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh print jobs"
          title="Refresh"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={15} />
        </button>
      </header>
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
      <header className="page-header">
        <h1>Settings</h1>
        <div className="spacer" />
        <span className="muted">Stored on this machine</span>
      </header>
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

function Sources({ onDecks }: { onDecks: () => void }) {
  return (
    <>
      <header className="page-header">
        <h1>Art sources</h1>
        <div className="spacer" />
        <button type="button" onClick={onDecks}>
          Open your decks
          <ArrowRight size={16} />
        </button>
      </header>
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
