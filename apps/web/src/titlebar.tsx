import { useQuery } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronRight,
  Copy,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Printer,
  Settings2,
  Square,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, defaultWindowChrome, type WindowChrome } from "./api.ts";

export interface Crumb {
  name: string;
  route?: string;
}

/**
 * The window's own title bar. It doubles as the drag region, hosts the
 * sidebar toggle and a few quick actions, and on Linux/Windows draws the
 * window controls because the system frame is turned off. On macOS the
 * native traffic lights overlay the left edge, so content starts after them.
 */
export function TitleBar({
  crumbs,
  sidebarOpen,
  onToggleSidebar,
  onNavigate,
  onNewDeck,
  route,
}: {
  crumbs: Crumb[];
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNavigate: (route: string) => void;
  onNewDeck: () => void;
  route: string;
}) {
  const [chrome, setChrome] = useState<WindowChrome>(defaultWindowChrome);
  useEffect(() => {
    let live = true;
    void api.windowChrome().then((value) => {
      if (live) setChrome(value);
    });
    return () => {
      live = false;
    };
  }, []);
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: ({ signal }) => api.jobs(signal),
    refetchInterval: 4000,
    retry: false,
  });
  const active =
    jobs.data?.filter((job) => ["queued", "running"].includes(job.status))
      .length ?? 0;
  const ToggleIcon = sidebarOpen ? PanelLeftClose : PanelLeftOpen;
  return (
    <header
      className="titlebar"
      data-platform={chrome.platform}
      data-tauri-drag-region
    >
      <div
        className="titlebar-group"
        style={{ paddingLeft: chrome.insetLeft || undefined }}
      >
        <button
          type="button"
          className="icon-button quiet"
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sidebarOpen}
          aria-keyshortcuts="Control+B Meta+B"
          title={`${sidebarOpen ? "Hide" : "Show"} sidebar (${chrome.platform === "macos" ? "⌘" : "Ctrl+"}B)`}
          onClick={onToggleSidebar}
        >
          <ToggleIcon size={16} />
        </button>
      </div>
      <nav className="titlebar-crumbs" aria-label="Location">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <span key={crumb.route ?? `page:${crumb.name}`} className="crumb">
              {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
              {crumb.route && !last ? (
                <button
                  type="button"
                  className="crumb-link"
                  onClick={() => onNavigate(crumb.route as string)}
                >
                  {crumb.name}
                </button>
              ) : (
                <span aria-current={last ? "page" : undefined}>
                  {crumb.name}
                </span>
              )}
            </span>
          );
        })}
      </nav>
      <div className="titlebar-group titlebar-actions">
        <button
          type="button"
          className="icon-button quiet"
          aria-label="New deck"
          title="New deck"
          onClick={onNewDeck}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          className="icon-button quiet"
          aria-label={
            active ? `Print jobs, ${active} in progress` : "Print jobs"
          }
          title="Print jobs"
          aria-current={route.startsWith("jobs") ? "page" : undefined}
          onClick={() => onNavigate("jobs")}
        >
          <Printer size={16} />
          {active > 0 && <span className="activity-dot" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="icon-button quiet"
          aria-label="Settings"
          title="Settings"
          aria-current={route.startsWith("settings") ? "page" : undefined}
          onClick={() => onNavigate("settings")}
        >
          <Settings2 size={16} />
        </button>
      </div>
      {chrome.customControls && <WindowControls />}
    </header>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const current = getCurrentWindow();
    let unlisten = () => {};
    let live = true;
    void current.isMaximized().then((value) => {
      if (live) setMaximized(value);
    });
    void current
      .onResized(() => {
        void current.isMaximized().then((value) => {
          if (live) setMaximized(value);
        });
      })
      .then((stop) => {
        if (live) unlisten = stop;
        else stop();
      });
    return () => {
      live = false;
      unlisten();
    };
  }, []);
  const run = (action: () => Promise<void>) => () => void action();
  return (
    <div className="window-controls">
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        onClick={run(() => getCurrentWindow().minimize())}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={run(() => getCurrentWindow().toggleMaximize())}
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        className="close"
        aria-label="Close window"
        title="Close"
        onClick={run(() => getCurrentWindow().close())}
      >
        <X size={15} />
      </button>
    </div>
  );
}
