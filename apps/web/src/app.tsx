import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  Download,
  HardDrive,
  Images,
  Layers3,
  ExternalLink as LinkIcon,
  Printer,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fetchHealth } from "./api.ts";
import { Library } from "./library.tsx";
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

export function App() {
  const [route, setRoute] = useState(routeFromHash);
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
      return;
    dirty.current = false;
    window.location.hash = `/${next}`;
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
      window.scrollTo(0, 0);
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
  const deckId = /^decks\/([\da-f-]{36})$/.exec(route)?.[1];
  return (
    <div className="app-shell">
      <button
        type="button"
        className="skip-link"
        onClick={() => document.getElementById("main")?.focus()}
      >
        Skip to content
      </button>
      <aside className="sidebar">
        <button
          type="button"
          className="brand"
          aria-label="Deckpress home"
          onClick={() => navigate("decks")}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 28 28"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <rect x="3" y="7" width="14" height="18" rx="3" />
            <path d="M10 3h12a3 3 0 0 1 3 3v15" />
            <path d="m8 16 2 3 3-6" />
          </svg>
          <span>Deckpress</span>
        </button>
        <nav aria-label="Main navigation">
          {[
            { id: "decks", name: "Decks", icon: Layers3 },
            { id: "sources", name: "Art sources", icon: Images },
            { id: "jobs", name: "Print jobs", icon: Printer },
            { id: "settings", name: "Settings", icon: Settings2 },
          ].map(({ id, name, icon: Icon }) => (
            <button
              type="button"
              key={id}
              aria-label={name}
              title={name}
              aria-current={route.startsWith(id) ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={18} />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="local-label">
            <HardDrive size={14} />
            <span>Local workspace</span>
          </span>
          <button
            type="button"
            className="connection"
            title="Check API connection"
            onClick={() => void health.refetch()}
          >
            <span className={`status-dot ${health.isError ? "offline" : ""}`} />
            <span>
              {health.isPending
                ? "Connecting…"
                : health.isError
                  ? "API offline · retry"
                  : "Saved on this machine"}
            </span>
          </button>
          <p>No account. No cloud sync.</p>
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
          <Library open={(id) => navigate(`decks/${id}`)} />
        )}
      </main>
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
        <button type="button" onClick={() => void query.refetch()}>
          Refresh
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
            <h2>Ready when your deck is.</h2>
            <p>
              Open a deck, choose Print setup, then generate your first PDF.
            </p>
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
                    <a
                      className="button primary"
                      href={`/api/jobs/${job.id}/download`}
                    >
                      <Download size={16} />
                      Download PDF
                    </a>
                  ) : ["queued", "running"].includes(job.status) ? (
                    <button
                      type="button"
                      disabled={task.busy}
                      onClick={() =>
                        void task.run(async () => {
                          await api.cancelJob(job.id);
                          await query.refetch();
                        })
                      }
                    >
                      <X size={15} />
                      Cancel export
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
            Use <strong>100% / actual size</strong> in your PDF viewer. Disable
            “Fit to page”. For AI exports, inspect rules text and mana symbols
            before printing.
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
  return (
    <>
      <header className="page-header">
        <h1>Settings</h1>
        <div className="spacer" />
        <span className="muted">Your local print workshop</span>
      </header>
      <div className="page-content settings-page">
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
        <section className="panel settings-card">
          <div className="section-heading">
            <h2>Local AI upscaling</h2>
            <span
              className={`badge ${query.data?.upscaler.available ? "official" : ""}`}
            >
              {query.data?.upscaler.available ? "Configured" : "Not configured"}
            </span>
          </div>
          <p>
            NMKD Siax 4× runs through the same NCNN / Vulkan engine used by
            Upscayl. It is a good candidate for clean scans and lightly
            compressed images. Fine lettering can change, so always check a
            proof.
          </p>
          <dl>
            <div>
              <dt>Model</dt>
              <dd className="mono">
                {query.data?.upscaler.model ?? "4x_NMKD-Siax_200k"}
              </dd>
            </div>
            <div>
              <dt>Scale</dt>
              <dd>4× per axis, then resized to target DPI</dd>
            </div>
            <div>
              <dt>Model license</dt>
              <dd>WTFPL, per OpenModelDB</dd>
            </div>
            <div>
              <dt>Execution</dt>
              <dd>Your machine. No cloud GPU.</dd>
            </div>
          </dl>
          <p className="hint">{query.data?.upscaler.reason}</p>
          <pre>pnpm setup:upscaler</pre>
          <p className="hint">
            Automatic setup supports macOS and Linux. For an existing engine,
            set UPSCALE_BIN, UPSCALE_MODELS, UPSCALE_MODEL and UPSCALE_ENGINE in
            the API environment. CPU-only machines can be very slow.
          </p>
          <div className="toolbar">
            <button type="button" onClick={() => void query.refetch()}>
              <Check size={15} />
              Check engine
            </button>
            <ExternalLink href="https://openmodeldb.info/models/4x-NMKD-Siax-CX">
              Model & license
              <LinkIcon size={13} />
            </ExternalLink>
          </div>
        </section>
        <section className="panel settings-card">
          <h2>Storage & portability</h2>
          <p>
            Decks, personal ratings and labels live in local SQLite. Images,
            upscaled results and PDFs are cached on disk under the API data
            directory.
          </p>
          <p>
            Use “Back up deck” to export a JSON project. It preserves
            quantities, art choices and print settings, but not image files.
            Custom uploads remain on this machine; keep the API data directory
            when moving your library.
          </p>
          <p className="hint">
            This proof of concept is a single-user local application. Do not
            expose the API to the internet. There is no account system or remote
            authorization.
          </p>
        </section>
        <section className="panel settings-card">
          <h2>Resolution, without the fine print</h2>
          <p>
            A typical Scryfall PNG is about 745 × 1040 pixels, roughly 300 DPI
            at card size. Setting 1200 DPI alone resamples those pixels. AI
            upscaling estimates detail; it cannot recover an original
            high-resolution scan.
          </p>
          <p>
            Use 300 DPI for proofs and 600 DPI for most home printing. Use 1200
            DPI when your print shop requests it. High-resolution MPC images may
            already meet the target without AI.
          </p>
        </section>
      </div>
    </>
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
          <span className="eyebrow">One card, many editions</span>
          <h2>
            Find a look that
            <br />
            <em>belongs in your deck.</em>
          </h2>
          <p>
            Choose a card in Art studio to browse these sources side by side.
            Your original printing always stays on the left.
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
