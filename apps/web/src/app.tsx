import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
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
  Wand2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Appearance,
  api,
  confirmAction,
  fetchHealth,
  type ModelStatus,
  saveFileDialog,
} from "./api.ts";
import { DiscardPreview } from "./art-picker.tsx";
import { formatCount, type PrintJob } from "./core/index.ts";
import { DeckBuilder } from "./deck-builder.tsx";
import { DeckSearch } from "./deck-search.tsx";
import { importStatus } from "./import-review.tsx";
import { Library } from "./library.tsx";
import { PrintLanguageSettings } from "./print-language.tsx";
import {
  ModalChromeProvider,
  PageToolbar,
  SidebarToggle,
  TitleBar,
  ToolbarSlotProvider,
  useWindowState,
} from "./titlebar.tsx";
import {
  ErrorNotice,
  ExternalLink,
  Modal,
  prettyDate,
  STATUS_COALESCE_MS,
  StatusRegion,
  UnkeyedLoading,
  useTask,
} from "./ui.tsx";
import { Workspace } from "./workspace.tsx";

declare global {
  interface Window {
    deckpressInitialAppearance?: Appearance;
    deckpressAppearance?: {
      readonly preference: Appearance;
      set(value: Appearance): void;
    };
  }
}

const routeFromHash = () =>
  window.location.hash.replace(/^#\/?/, "") || "decks";

const library = [
  { id: "decks", name: "Decks", icon: Layers3 },
  { id: "jobs", name: "Print jobs", icon: Printer },
  { id: "sources", name: "Art sources", icon: Images },
  { id: "discover", name: "Discover", icon: Compass },
  { id: "builder", name: "Deck builder", icon: Wand2 },
];
const RECENT_DECKS = 6;
const SIDEBAR_KEY = "deckpress.sidebar";
const confirmDiscard = () =>
  confirmAction(
    "Leave this deck and discard unsaved changes?",
    "Discard changes",
  );
const deckRoute = (route: string) =>
  /^decks\/([\da-f-]{36})(?:\/print\/([\da-f-]{36}))?$/.exec(route);
const focusMain = () => document.getElementById("main")?.focus();
type ImportAnnouncement = { id: string; text: string; restoreKey?: number };
type WindowExit = {
  dirty: boolean;
  art: boolean;
  jobs: number;
  resolve: (close: boolean) => void;
};
const countActiveJobs = (jobs: PrintJob[] = []) =>
  jobs.filter((job) => job.status === "queued" || job.status === "running")
    .length;

function readSidebar(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [importedDeckId, setImportedDeckId] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(readSidebar);
  const [newDeckRequest, setNewDeckRequest] = useState(0);
  const [pendingImport, setPendingImport] = useState<ImportAnnouncement | null>(
    null,
  );
  const [importAnnouncement, setImportAnnouncement] =
    useState<ImportAnnouncement | null>(null);
  const restoreSequence = useRef(0);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [artExitOpen, setArtExitOpen] = useState(false);
  const [editionsLoading, setEditionsLoading] = useState(false);
  const artPreview = useRef(false);
  const policyPreview = useRef<{
    discard: () => void;
    canDiscard: () => boolean;
  } | null>(null);
  const artExit = useRef<((discard: boolean) => void) | null>(null);
  const artExitDestination = useRef<string | null>(null);
  const onPreviewChange = useCallback((changed: boolean) => {
    artPreview.current = changed;
  }, []);
  const registerPolicyPreview = useCallback(
    (preview: typeof policyPreview.current) => {
      policyPreview.current = preview;
    },
    [],
  );
  const hasArtPreview = useCallback(
    () => artPreview.current || policyPreview.current !== null,
    [],
  );
  const confirmArtExit = useCallback(
    (trigger?: HTMLElement) => {
      if (artExit.current) return false;
      if (!hasArtPreview()) return true;
      if (policyPreview.current) {
        if (!policyPreview.current.canDiscard()) return false;
      } else trigger?.focus();
      setArtExitOpen(true);
      return new Promise<boolean>((resolve) => {
        artExit.current = resolve;
      });
    },
    [hasArtPreview],
  );
  const finishArtExit = (discard: boolean) => {
    const resolve = artExit.current;
    artExit.current = null;
    if (discard) policyPreview.current?.discard();
    setArtExitOpen(false);
    resolve?.(discard);
  };
  const routeRef = useRef(route);
  const dirty = useRef(false);
  const closingWindow = useRef(false);
  const [windowExit, setWindowExit] = useState<WindowExit | null>(null);
  const client = useQueryClient();
  const confirmWindowExit = useCallback(async () => {
    if (closingWindow.current || artExit.current) return false;
    closingWindow.current = true;
    const jobs = countActiveJobs(
      await api.jobs().catch(() => client.getQueryData<PrintJob[]>(["jobs"])),
    );
    if (artExit.current || policyPreview.current?.canDiscard() === false) {
      closingWindow.current = false;
      return false;
    }
    if (!dirty.current && !jobs) {
      closingWindow.current = false;
      return confirmArtExit();
    }
    return new Promise<boolean>((resolve) => {
      setWindowExit({
        dirty: dirty.current,
        art: hasArtPreview(),
        jobs,
        resolve,
      });
    });
  }, [client, confirmArtExit, hasArtPreview]);
  const finishWindowExit = (close: boolean) => {
    if (close) policyPreview.current?.discard();
    closingWindow.current = false;
    setWindowExit(null);
    windowExit?.resolve(close);
  };
  const window_ = useWindowState(confirmWindowExit);
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
  const activeJobs = countActiveJobs(jobs.data);
  const { status, alert, announceJobs, announceStatus } =
    usePrintJobAnnouncements(jobs.data);
  const applyRoute = useCallback((next: string) => {
    routeRef.current = next;
    setImportedDeckId((id) => (deckRoute(next)?.[1] === id ? id : undefined));
    setRoute(next);
    const main = document.getElementById("main");
    if (main) main.scrollTop = 0;
  }, []);
  const navigate = useCallback(
    async (next: string, saved = false, trigger?: HTMLElement) => {
      if (next === routeRef.current) return true;
      const hadPreview = hasArtPreview();
      const exit = confirmArtExit(trigger);
      if (exit === false || (exit !== true && !(await exit))) return false;
      if (!saved && dirty.current && !(await confirmDiscard())) return false;
      if (hadPreview) artExitDestination.current = next;
      dirty.current = false;
      window.location.hash = `/${next}`;
      applyRoute(next);
      return true;
    },
    [applyRoute, confirmArtExit, hasArtPreview],
  );
  const openImportedDeck = async (
    id: string,
    importedCards?: number,
    updatedUploads?: number,
  ) => {
    if (!(await navigate(`decks/${id}`))) return;
    setImportedDeckId(id);
    if (updatedUploads !== undefined) {
      const bleed =
        updatedUploads > 0
          ? `, updated source bleed on ${updatedUploads} ${updatedUploads === 1 ? "upload" : "uploads"}`
          : "";
      setPendingImport({
        id,
        text: `Deck restored${bleed}`,
        restoreKey: ++restoreSequence.current,
      });
    } else if (importedCards !== undefined)
      setPendingImport({ id, text: importStatus(null, importedCards) });
  };
  useEffect(() => {
    const onChange = () => {
      const next = routeFromHash();
      if (next === routeRef.current) return;
      if (dirty.current || hasArtPreview()) {
        window.history.replaceState(null, "", `#/${routeRef.current}`);
        void navigate(next);
        return;
      }
      applyRoute(next);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current || hasArtPreview()) event.preventDefault();
    };
    window.addEventListener("hashchange", onChange);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("beforeunload", unload);
    };
  }, [applyRoute, hasArtPreview, navigate]);
  useEffect(() => {
    if (artExitDestination.current !== route) return;
    artExitDestination.current = null;
    if (document.activeElement === document.body) focusMain();
  }, [route]);
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
  const newDeck = async (trigger?: HTMLElement) => {
    if (await navigate("decks", false, trigger))
      setNewDeckRequest((count) => count + 1);
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
  const [, deckId, printJobId] = deckRoute(route) ?? [];
  const printJob = jobs.data?.find(
    (job) => job.id === printJobId && job.deckId === deckId,
  );
  useEffect(() => {
    if (!pendingImport || pendingImport.id !== deckId) return;
    setImportAnnouncement(pendingImport);
    setPendingImport(null);
  }, [deckId, pendingImport]);
  const recent = (decks.data ?? [])
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_DECKS);
  const modifier = window_.platform === "macos" ? "⌘" : "Ctrl+";
  const shell = (
    <div
      className="app-shell"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-platform={window_.platform}
      data-focused={window_.focused}
      style={{
        ["--inset-left" as string]: `${window_.fullscreen ? 0 : window_.insetLeft}px`,
      }}
    >
      <button type="button" className="skip-link" onClick={focusMain}>
        Skip to content
      </button>
      <StatusRegion
        label="Print job announcements"
        announcementId={status?.key}
      >
        {status?.text}
      </StatusRegion>
      <p
        className="sr-only"
        role="alert"
        aria-label="Print job failures"
        aria-atomic="true"
      >
        {alert && (
          // biome-ignore lint/a11y/useSemanticElements: Expose the inline announcement as a child in WebKitGTK's accessibility tree.
          <span key={alert.key} role="group">
            {alert.text}{" "}
          </span>
        )}
      </p>
      <StatusRegion
        label="Import announcements"
        announcementId={
          importAnnouncement?.restoreKey ?? importAnnouncement?.id
        }
      >
        {importAnnouncement?.text}
      </StatusRegion>
      <StatusRegion label="Art editions loading">
        {editionsLoading ? "Finding editions…" : ""}
      </StatusRegion>
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
            onClick={(event) => void newDeck(event.currentTarget)}
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
                onClick={(event) =>
                  void navigate(id, false, event.currentTarget)
                }
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
                    onClick={(event) =>
                      void navigate(
                        `decks/${deck.id}`,
                        false,
                        event.currentTarget,
                      )
                    }
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
            onClick={(event) =>
              void navigate("settings", false, event.currentTarget)
            }
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
                key={route}
                id={deckId}
                printSetup={printJobId ? { failure: printJob } : undefined}
                focusHeading={
                  !printJob?.failureTarget &&
                  (!!printJobId || importedDeckId === deckId)
                }
                restoreMessage={
                  importAnnouncement?.id === deckId &&
                  importAnnouncement.restoreKey !== undefined
                    ? importAnnouncement.text
                    : undefined
                }
                onDirty={onDirty}
                onPreviewChange={onPreviewChange}
                registerPolicyPreview={registerPolicyPreview}
                onEditionsLoading={setEditionsLoading}
                confirmArtExit={confirmArtExit}
                onBack={(trigger) => void navigate("decks", false, trigger)}
                onJobs={(job) => {
                  announceJobs([job]);
                  void navigate("jobs", true);
                }}
              />
            ) : route === "jobs" ? (
              <PrintJobs
                active={activeJobs}
                deckIds={decks.data?.map((deck) => deck.id)}
                deckCheckFailed={decks.isError}
                onRetry={announceJobs}
                onOpenSetup={async (job) => {
                  if (await navigate(`decks/${job.deckId}/print/${job.id}`)) {
                    announceStatus(`Opening Print setup for ${job.deckName}.`);
                  }
                }}
              />
            ) : route === "settings" || route === "settings/models" ? (
              <LocalSettings focusModels={route === "settings/models"} />
            ) : route === "sources" ? (
              <Sources />
            ) : route === "discover" ? (
              <DeckSearch open={openImportedDeck} />
            ) : route === "builder" ? (
              <DeckBuilder
                onDirty={onDirty}
                onBack={() => void navigate("decks")}
                onCreated={(id) => void navigate(`decks/${id}`, true)}
              />
            ) : (
              <Library
                open={(id) => void navigate(`decks/${id}`)}
                openImported={openImportedDeck}
                createRequest={newDeckRequest}
                onCreateHandled={() => setNewDeckRequest(0)}
                onBuild={() => void navigate("builder")}
              />
            )}
          </ToolbarSlotProvider>
        </main>
      </div>
      {artExitOpen && (
        <DiscardPreview
          leaving={policyPreview.current ? "workspace" : "studio"}
          onStay={() => finishArtExit(false)}
          onDiscard={() => finishArtExit(true)}
          focusFallback={focusMain}
        />
      )}
      {windowExit && (
        <Modal
          title="Close Deckpress?"
          description={[
            windowExit.dirty && "Unsaved changes will be lost.",
            windowExit.art && "Your unapplied art preview will be discarded.",
            windowExit.jobs === 1
              ? "A print job will be interrupted."
              : windowExit.jobs > 1 &&
                `${windowExit.jobs} print jobs will be interrupted.`,
          ]
            .filter(Boolean)
            .join(" ")}
          onClose={() => finishWindowExit(false)}
          showClose={false}
          focusFallback={focusMain}
        >
          <div className="modal-actions">
            <button
              type="button"
              className="primary"
              ref={(button) => button?.setAttribute("autofocus", "")}
              onClick={() => finishWindowExit(false)}
            >
              Cancel
            </button>
            <button type="button" onClick={() => finishWindowExit(true)}>
              Close Deckpress
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
  return (
    <ModalChromeProvider value={window_.customControls}>
      {shell}
    </ModalChromeProvider>
  );
}

type JobAnnouncement = {
  id: string;
  key: string;
  text: string;
  terminal: boolean;
};
const JOB_ANNOUNCEMENT_DWELL_MS = 100;

function usePrintJobAnnouncementChannel() {
  const [message, setMessage] = useState<JobAnnouncement>();
  const queue = useRef<JobAnnouncement[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const publish = useCallback(function next() {
    if (timer.current !== undefined) return;
    const announcement = queue.current.shift();
    if (!announcement) return;
    setMessage(announcement);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      next();
    }, JOB_ANNOUNCEMENT_DWELL_MS);
  }, []);
  const enqueue = useCallback(
    (announcement: JobAnnouncement) => {
      queue.current.push(announcement);
      publish();
    },
    [publish],
  );
  const discardIntermediate = useCallback((id: string) => {
    queue.current = queue.current.filter(
      (announcement) => announcement.terminal || announcement.id !== id,
    );
  }, []);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      queue.current = [];
    },
    [],
  );
  return { message, enqueue, discardIntermediate };
}

function usePrintJobAnnouncements(jobs: PrintJob[] | undefined) {
  const seen = useRef(new Map<string, Set<PrintJob["status"]>>());
  const initialized = useRef(false);
  const actionId = useRef(0);
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const {
    message: status,
    enqueue: notify,
    discardIntermediate,
  } = usePrintJobAnnouncementChannel();
  const { message: alert, enqueue: notifyFailure } =
    usePrintJobAnnouncementChannel();
  useEffect(() => {
    const timers = pending.current;
    const statuses = seen.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      statuses.clear();
      initialized.current = false;
    };
  }, []);
  const announceJobs = useCallback(
    (snapshot: PrintJob[], initial = false) => {
      for (const { id, status, deckName, message, format } of snapshot) {
        let statuses = seen.current.get(id);
        if (!statuses) {
          statuses = new Set();
          seen.current.set(id, statuses);
        }
        if (
          statuses.has(status) ||
          statuses.has("completed") ||
          statuses.has("failed") ||
          statuses.has("cancelled") ||
          (status === "queued" && statuses.has("running"))
        )
          continue;
        statuses.add(status);
        const timer = pending.current.get(id);
        if (timer !== undefined) {
          clearTimeout(timer);
          pending.current.delete(id);
        }
        discardIntermediate(id);
        const terminal = status !== "queued" && status !== "running";
        if (initial && terminal && statuses.size === 1) continue;
        const phase =
          terminal && status !== "cancelled" && !statuses.has("running")
            ? `started and ${status}`
            : status;
        const subject = `${format === "png" ? "PNG export" : "Print job"} for ${deckName}`;
        // PNG results name the faces skipped for missing art.
        const detail =
          status === "failed" || (status === "completed" && format === "png");
        const announcement = {
          id,
          terminal,
          key: `${id}:${status}`,
          text:
            status === "cancelled"
              ? "Cancelled"
              : detail
                ? `${subject} ${phase}: ${message}`
                : `${subject} ${phase}.`,
        };
        if (terminal) {
          (status === "failed" ? notifyFailure : notify)(announcement);
        } else {
          pending.current.set(
            id,
            setTimeout(() => {
              pending.current.delete(id);
              notify(announcement);
            }, STATUS_COALESCE_MS),
          );
        }
      }
    },
    [discardIntermediate, notify, notifyFailure],
  );
  useEffect(() => {
    if (!jobs) return;
    announceJobs(jobs, !initialized.current);
    initialized.current = true;
  }, [jobs, announceJobs]);
  const announceStatus = (text: string) => {
    const key = `recovery:${++actionId.current}`;
    notify({ id: key, terminal: true, key, text });
  };
  return { status, alert, announceJobs, announceStatus };
}

function PrintJobs({
  active,
  deckIds,
  deckCheckFailed,
  onRetry,
  onOpenSetup,
}: {
  active: number;
  deckIds: string[] | undefined;
  deckCheckFailed: boolean;
  onRetry: (jobs: PrintJob[]) => void;
  onOpenSetup: (job: PrintJob) => Promise<void>;
}) {
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
  const [saveStatus, setSaveStatus] = useState("");
  const total = query.data?.length ?? 0;
  return (
    <>
      <PageToolbar
        title="Print jobs"
        subtitle={
          active
            ? `${active} in progress`
            : total
              ? formatCount(total, "export")
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
        <StatusRegion label="Export save status">
          {task.error ? "" : saveStatus}
        </StatusRegion>
        <ErrorNotice
          error={query.error ?? task.error}
          {...(query.error ? { retry: () => void query.refetch() } : {})}
        />
        {query.isPending ? (
          <UnkeyedLoading>Loading print jobs…</UnkeyedLoading>
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
                  <p>{job.message}</p>
                  {["queued", "running"].includes(job.status) && (
                    <progress
                      aria-label={`Export progress for ${job.deckName}`}
                      value={job.completed}
                      max={job.total || 1}
                    />
                  )}
                  <div className="job-meta">
                    <span>{prettyDate(job.createdAt)}</span>
                    <span>
                      {job.format === "png"
                        ? formatCount(job.pages, "PNG file")
                        : formatCount(job.pages, "PDF page")}
                    </span>
                    {job.bytes > 0 && (
                      <span>{(job.bytes / 1024 / 1024).toFixed(1)} MB</span>
                    )}
                    <span>
                      {job.completed.toLocaleString()} /{" "}
                      {formatCount(job.total, "face")}
                    </span>
                  </div>
                  {job.status === "completed" && job.calibrationPage && (
                    <p className="hint">
                      Measure the ruler on the print-size calibration page
                      before the full run.
                    </p>
                  )}
                </div>
                <div className="job-actions">
                  {job.status === "completed" ? (
                    <>
                      {job.format === "pdf" && (
                        <button
                          type="button"
                          className="primary"
                          disabled={task.busy}
                          onClick={() =>
                            void task.run(() => api.openPdf(job.id))
                          }
                        >
                          <Printer size={16} />
                          Open PDF
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Save a copy"
                        title="Save a copy…"
                        disabled={task.busy}
                        onClick={() =>
                          void task.run(async () => {
                            setSaveStatus("");
                            const destination = await saveFileDialog({
                              defaultPath: job.fileName,
                              filters:
                                job.format === "png"
                                  ? [
                                      {
                                        name: "ZIP of PNGs",
                                        extensions: ["zip"],
                                      },
                                    ]
                                  : [{ name: "PDF", extensions: ["pdf"] }],
                            });
                            if (destination) {
                              setSaveStatus(
                                `Saving export for ${job.deckName}…`,
                              );
                              await api.savePdf(job.id, destination);
                              setSaveStatus(
                                `Export for ${job.deckName} saved.`,
                              );
                            }
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
                  ) : deckIds?.includes(job.deckId) ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void onOpenSetup(job)}
                      >
                        Back to print setup
                      </button>
                      {job.settings ? (
                        <button
                          type="button"
                          disabled={task.busy}
                          onClick={() =>
                            void task.run(async () => {
                              if (!job.settings) return;
                              onRetry([
                                await api.createJob(
                                  job.deckId,
                                  job.settings,
                                  job.format,
                                ),
                              ]);
                              await query.refetch();
                            })
                          }
                        >
                          Retry
                        </button>
                      ) : (
                        <p className="hint">
                          Original print settings unavailable for Retry.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="hint">
                      {deckIds
                        ? "This deck no longer exists."
                        : deckCheckFailed
                          ? "Could not check whether this deck still exists."
                          : "Checking for the original deck…"}
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        <div className="notice print-job-note">
          <Printer size={19} />
          <span>
            Print at <strong>100% / actual size</strong>. Disable “Fit to page”.
            For AI exports, inspect rules text and mana symbols.
          </span>
        </div>
      </div>
    </>
  );
}

function LocalSettings({ focusModels }: { focusModels: boolean }) {
  const modelsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusModels) modelsHeading.current?.focus();
  }, [focusModels]);
  const [appearance, setAppearance] = useState(
    () => window.deckpressAppearance?.preference ?? "system",
  );
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.settings(signal),
  });
  const task = useTask();
  const download = useMutation({
    mutationFn: api.downloadModel,
    onSuccess: () => query.refetch(),
  });
  const busy = task.busy || download.isPending;
  const failedModelId = download.isError ? download.variables : undefined;
  const downloadName = query.data?.models.find(
    (model) => model.id === download.variables,
  )?.name;
  const loaded = query.data?.loaded;
  return (
    <>
      <PageToolbar title="Settings">
        <button
          type="button"
          className="icon-button quiet"
          aria-label="Open data folder"
          title="Open data folder"
          disabled={busy}
          onClick={() => void task.run(() => api.openDataDir())}
        >
          <FolderOpen size={16} />
        </button>
      </PageToolbar>
      <div className="page-content settings-page">
        <section className="panel settings-card">
          <h2>Appearance</h2>
          <label className="field">
            Theme
            <select
              value={appearance}
              disabled={task.busy}
              onChange={(event) => {
                const theme = event.currentTarget.value as Appearance;
                void task.run(async () => {
                  if (isTauri()) await api.saveAppearance(theme);
                  setAppearance(theme);
                  window.deckpressAppearance?.set(theme);
                });
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </section>
        <ErrorNotice
          error={query.error ?? task.error}
          retry={() => void query.refetch()}
        />
        {query.data && (
          <PrintLanguageSettings saved={query.data.printLanguage} />
        )}
        <section className="panel settings-card">
          <StatusRegion label="Model download status">
            {downloadName && download.isPending
              ? `Downloading ${downloadName}…`
              : downloadName && download.isSuccess
                ? `${downloadName} downloaded.`
                : ""}
          </StatusRegion>
          <div className="section-heading">
            <h2 ref={modelsHeading} tabIndex={-1}>
              Local AI upscaling
            </h2>
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
          {failedModelId && !busy && (
            <ErrorNotice
              error={download.error}
              retry={() => download.mutate(failedModelId)}
            />
          )}
          <div className="model-list">
            {(query.data?.models ?? []).map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                isDefault={model.id === query.data?.defaultModel}
                loaded={loaded?.modelId === model.id}
                busy={busy}
                downloading={
                  model.downloading ||
                  (download.isPending && download.variables === model.id)
                }
                onDownload={() => download.mutate(model.id)}
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
  downloading,
  onDownload,
  onLoad,
}: {
  model: ModelStatus;
  isDefault: boolean;
  loaded: boolean;
  busy: boolean;
  downloading: boolean;
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
            disabled={busy || downloading}
            onClick={onDownload}
          >
            <Download size={15} />
            {downloading ? "Downloading…" : "Download"}
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
