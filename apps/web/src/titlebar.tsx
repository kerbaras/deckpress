import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import {
  Copy,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Square,
  X,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { api, defaultWindowChrome, type WindowChrome } from "./api.ts";

/** Null outside Tauri (Vite in a browser, Vitest). */
function currentWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export interface WindowState extends WindowChrome {
  focused: boolean;
  fullscreen: boolean;
}

/** Platform chrome plus the live window state the shell styles react to. */
export function useWindowState(): WindowState {
  const [chrome, setChrome] = useState<WindowChrome>(defaultWindowChrome);
  const [focused, setFocused] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    let live = true;
    void api.windowChrome().then((value) => {
      if (live) setChrome(value);
    });
    const current = currentWindow();
    if (!current) {
      return () => {
        live = false;
      };
    }
    const stops: Array<() => void> = [];
    const track = (promise: Promise<() => void>) =>
      promise
        .then((stop) => {
          if (live) stops.push(stop);
          else stop();
        })
        .catch(() => {});
    const syncFullscreen = () =>
      current
        .isFullscreen()
        .then((value) => {
          if (live) setFullscreen(value);
        })
        .catch(() => {});
    void syncFullscreen();
    track(current.onFocusChanged(({ payload }) => setFocused(payload)));
    track(current.onResized(() => void syncFullscreen()));
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, []);
  return { ...chrome, focused, fullscreen };
}

const ToolbarSlot = createContext<HTMLElement | null>(null);

export const ToolbarSlotProvider = ToolbarSlot.Provider;

/**
 * A page's contribution to the window toolbar. Pages render this wherever
 * their state lives; the contents are portalled into the bar so the title,
 * search field and actions change with the route while the shell stays put.
 */
export function PageToolbar({
  title,
  subtitle,
  leading,
  center,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Navigation controls before the title, such as a back button. */
  leading?: ReactNode;
  /** View-level controls, such as a segmented switcher. */
  center?: ReactNode;
  /** Actions and search, trailing edge. */
  children?: ReactNode;
}) {
  const slot = useContext(ToolbarSlot);
  if (!slot) return null;
  return createPortal(
    <>
      <div className="toolbar-lead" data-tauri-drag-region>
        {leading}
        <h1 className="toolbar-title" data-tauri-drag-region>
          {title}
        </h1>
        {subtitle && (
          <span className="toolbar-subtitle" data-tauri-drag-region>
            {subtitle}
          </span>
        )}
      </div>
      <div className="toolbar-center" data-tauri-drag-region>
        {center}
      </div>
      <div className="toolbar-trail" data-tauri-drag-region>
        {children}
      </div>
    </>,
    slot,
  );
}

export function SidebarToggle({
  open,
  platform,
  onToggle,
}: {
  open: boolean;
  platform: WindowChrome["platform"];
  onToggle: () => void;
}) {
  const Icon = open ? PanelLeftClose : PanelLeftOpen;
  const key = platform === "macos" ? "⌘B" : "Ctrl+B";
  return (
    <button
      type="button"
      className="icon-button quiet"
      aria-label={open ? "Hide sidebar" : "Show sidebar"}
      aria-pressed={open}
      aria-keyshortcuts="Control+B Meta+B"
      title={`${open ? "Hide" : "Show"} sidebar (${key})`}
      onClick={onToggle}
    >
      <Icon size={16} />
    </button>
  );
}

/**
 * The content column's segment of the window frame. Pages fill it through
 * `PageToolbar`; on Linux/Windows it also draws the window controls because
 * the system frame is turned off.
 */
export function TitleBar({
  state,
  sidebarOpen,
  onToggleSidebar,
  onSlot,
}: {
  state: WindowState;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSlot: (node: HTMLElement | null) => void;
}) {
  return (
    <header className="titlebar" data-tauri-drag-region>
      {!sidebarOpen && (
        <div className="titlebar-group" data-tauri-drag-region>
          <SidebarToggle
            open={false}
            platform={state.platform}
            onToggle={onToggleSidebar}
          />
        </div>
      )}
      <div className="toolbar-slot" ref={onSlot} data-tauri-drag-region />
      {state.customControls && <WindowControls />}
    </header>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const current = currentWindow();
    if (!current) return;
    let unlisten = () => {};
    let live = true;
    const sync = () =>
      current
        .isMaximized()
        .then((value) => {
          if (live) setMaximized(value);
        })
        .catch(() => {});
    void sync();
    void current
      .onResized(() => void sync())
      .then((stop) => {
        if (live) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    return () => {
      live = false;
      unlisten();
    };
  }, []);
  const run = (action: (window: Window) => Promise<void>) => () => {
    const current = currentWindow();
    if (current) void action(current);
  };
  return (
    <div className="window-controls">
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        onClick={run((window) => window.minimize())}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={run((window) => window.toggleMaximize())}
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        className="close"
        aria-label="Close window"
        title="Close"
        onClick={run((window) => window.close())}
      >
        <X size={15} />
      </button>
    </div>
  );
}
