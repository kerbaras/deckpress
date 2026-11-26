import { AlertCircle, ImageOff, LoaderCircle, Search, X } from "lucide-react";
import {
  Children,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ZodError } from "zod";
import { imageSrc, uploadTrimSrc } from "./api.ts";
import type { Art, DeckEntry } from "./core/index.ts";
import { ModalWindowChrome } from "./titlebar.tsx";

export const zoneNames = {
  main: "Mainboard",
  commander: "Commander",
  companion: "Companion",
  side: "Sideboard",
  maybe: "Maybeboard",
  tokens: "Tokens",
};
/** Board label for a count: one Companion, several Companions. */
export const zoneLabel = (zone: DeckEntry["zone"], count: number) =>
  zone === "companion" && count !== 1 ? "Companions" : zoneNames[zone];
export const countCards = (entries: DeckEntry[]) =>
  entries.reduce((sum, entry) => sum + entry.quantity, 0);
export const providerName = (art: Art) =>
  ({
    scryfall: "Official · Scryfall",
    mpc: "Community · MPC",
    upload: "My upload",
  })[art.provider];
export const prettyDate = (date: string) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(date),
  );

export function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    if (!issue) return "Invalid input";
    const field = issue.path.map(String).join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function ErrorNotice({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <AlertCircle size={17} />
      <span>{errorMessage(error)}</span>
      {retry && (
        <button type="button" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Loading({
  active = true,
  announcementId,
  label,
  children = "Loading…",
}: {
  active?: boolean;
  announcementId?: string;
  label?: string;
  children?: string;
}) {
  const ready = usePainted(!active);
  return (
    <>
      <StatusRegion label={label} announcementId={announcementId}>
        {active && ready ? children : ""}
      </StatusRegion>
      {active && <LoadingIndicator>{children}</LoadingIndicator>}
    </>
  );
}

function usePainted(initial: boolean) {
  const [ready, setReady] = useState(initial);
  useEffect(() => {
    let afterPaint = 0;
    const frame = requestAnimationFrame(() => {
      afterPaint = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(afterPaint);
    };
  }, []);
  return ready;
}

export function useLoadingSequence() {
  const announce = usePainted(false);
  const [start, setStart] = useState(false);
  useEffect(() => {
    if (!announce) return;
    const frame = requestAnimationFrame(() => setStart(true));
    return () => cancelAnimationFrame(frame);
  }, [announce]);
  return { announce, start };
}

export function LoadingIndicator({ children }: { children: string }) {
  return (
    <div className="loading" aria-hidden="true">
      <LoaderCircle size={19} className="spin" />
      <span>{children}</span>
    </div>
  );
}

export function UnkeyedLoading({ children }: { children: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={19} className="spin" />
      {children}
    </div>
  );
}

export const STATUS_COALESCE_MS = 50;

export function StatusRegion({
  as: Element = "p",
  children,
  className = "sr-only",
  label,
  announcementId,
  coalesce = false,
}: {
  as?: "p" | "span";
  children: ReactNode;
  className?: string;
  label?: string | undefined;
  announcementId?: string | number | undefined;
  coalesce?: boolean;
}) {
  const hasMessage = Children.toArray(children).some((child) => child !== "");
  const [settled, setSettled] = useState<{
    message: ReactNode;
    id: typeof announcementId;
  }>();
  useEffect(() => {
    if (!coalesce || !hasMessage) {
      setSettled(undefined);
      return;
    }
    const timer = setTimeout(
      () => setSettled({ message: children, id: announcementId }),
      STATUS_COALESCE_MS,
    );
    return () => clearTimeout(timer);
  }, [announcementId, children, coalesce, hasMessage]);
  const message = coalesce ? (hasMessage ? settled?.message : null) : children;
  const messageId = coalesce ? settled?.id : announcementId;
  const [announcement, setAnnouncement] = useState({
    message,
    messageId,
    sequence: 0,
  });
  if (
    !Object.is(message, announcement.message) ||
    !Object.is(messageId, announcement.messageId)
  ) {
    setAnnouncement({
      message,
      messageId,
      sequence: announcement.sequence + 1,
    });
  }
  return (
    <Element
      className={className}
      role="status"
      aria-atomic="true"
      aria-label={label}
    >
      {Children.toArray(message).some((child) => child !== "") && (
        // biome-ignore lint/a11y/useSemanticElements: Expose the inline announcement as a child in WebKitGTK's accessibility tree.
        <span key={announcement.sequence} role="group">
          {message}
        </span>
      )}
    </Element>
  );
}

export function SearchField({
  value,
  onChange,
  label,
  ref,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  ref?: Ref<HTMLInputElement>;
  compact?: boolean;
}) {
  const Container = compact ? "div" : "label";
  return (
    <Container className="search">
      {!compact && <span className="search-label">{label}</span>}
      <Search className="size-icon stroke-icon" aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        aria-label={compact ? label : undefined}
        placeholder={compact ? label : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Container>
  );
}

export function ArtThumbnail({
  art,
  url = art.thumbnailUrl,
  ...props
}: Omit<Parameters<typeof CardImage>[0], "url" | "src"> & {
  art: Art;
  url?: string;
}) {
  return (
    <CardImage
      {...props}
      url={url}
      src={
        art.provider === "upload" && art.bleedMm > 0
          ? uploadTrimSrc(art, true)
          : undefined
      }
    />
  );
}

export function CardImage({
  url,
  src = imageSrc(url),
  name,
  className = "",
  eager = false,
  onLoad,
}: {
  url: string;
  src?: string | undefined;
  name: string;
  className?: string;
  eager?: boolean;
  onLoad?: (() => void) | undefined;
}) {
  return (
    <ImageContent
      key={src}
      src={src}
      name={name}
      className={className}
      eager={eager}
      onLoad={onLoad}
    />
  );
}

function ImageContent({
  src,
  name,
  className,
  eager,
  onLoad,
}: {
  src: string;
  name: string;
  className: string;
  eager: boolean;
  onLoad?: (() => void) | undefined;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`card-image ${className}`}>
      {failed ? (
        <span className="image-fallback">
          <ImageOff size={22} />
          <span>{name}</span>
          <small>Image unavailable</small>
        </span>
      ) : (
        <img
          src={src}
          alt={name}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={onLoad}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function Modal({
  title,
  description,
  children,
  onClose,
  busy = false,
  wide = false,
  showClose = true,
  focusFallback,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  showClose?: boolean;
  focusFallback?: (() => void) | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      if (document.activeElement === document.body) focusFallback?.();
    };
  }, [focusFallback]);
  return (
    <dialog
      ref={ref}
      className={wide ? "modal modal-wide" : "modal"}
      aria-label={title}
      aria-modal="true"
      aria-describedby={description ? descriptionId : undefined}
      onKeyDown={(event) => trapTab(event, panel.current)}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-panel" ref={panel}>
        <div className="modal-heading">
          <h2>{title}</h2>
          {showClose && (
            <button
              type="button"
              className="icon-button"
              aria-label="Close dialog"
              disabled={busy}
              onClick={onClose}
            >
              <X size={18} />
            </button>
          )}
        </div>
        {description && <p id={descriptionId}>{description}</p>}
        {children}
      </div>
      <ModalWindowChrome />
    </dialog>
  );
}

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab cycling inside an open dialog. */
function trapTab(
  event: KeyboardEvent<HTMLElement>,
  dialog: HTMLElement | null,
) {
  if (event.key !== "Tab" || !dialog) return;
  const items = [...dialog.querySelectorAll<HTMLElement>(focusable)];
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof Node && dialog.contains(active);
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault();
    first.focus();
  }
}

export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const running = useRef(false);
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      setError(cause);
      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function ManaPips({ colors }: { colors: string[] }) {
  return (
    <span
      className="mana-pips"
      role="img"
      aria-label={colors.length ? `Colors: ${colors.join(", ")}` : "Colorless"}
    >
      {colors.map((color) => (
        <span key={color} className={`mana mana-${color}`}>
          {color}
        </span>
      ))}
    </span>
  );
}

export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  if (!/^https:\/\//i.test(href)) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="external-link">
      {children}
    </a>
  );
}
