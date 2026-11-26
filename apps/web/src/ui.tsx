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
import { imageSrc } from "./api.ts";
import type { Art, DeckEntry } from "./core/index.ts";

export const zoneNames = {
  main: "Mainboard",
  commander: "Commander",
  side: "Sideboard",
  maybe: "Maybeboard",
  tokens: "Tokens",
};
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

export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={19} className="spin" />
      {children}
    </div>
  );
}

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
  label?: string;
  announcementId?: string | number | undefined;
  coalesce?: boolean;
}) {
  const hasMessage = Children.toArray(children).some((child) => child !== "");
  const [settled, setSettled] = useState<{
    message: ReactNode;
    id: typeof announcementId;
  }>();
  useEffect(() => {
    if (!coalesce) return;
    if (!hasMessage) {
      setSettled(undefined);
      return;
    }
    const timer = setTimeout(
      () => setSettled({ message: children, id: announcementId }),
      50,
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

export function CardImage({
  url,
  name,
  className = "",
  eager = false,
}: {
  url: string;
  name: string;
  className?: string;
  eager?: boolean;
}) {
  return (
    <ImageContent
      key={url}
      url={url}
      name={name}
      className={className}
      eager={eager}
    />
  );
}

function ImageContent({
  url,
  name,
  className,
  eager,
}: {
  url: string;
  name: string;
  className: string;
  eager: boolean;
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
          src={imageSrc(url)}
          alt={name}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
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
      aria-describedby={description ? descriptionId : undefined}
      onKeyDown={(event) => trapTab(event, ref.current)}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
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
  if (!first || !last) return;
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
