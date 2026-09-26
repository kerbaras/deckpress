import type { Art, DeckEntry } from "@deckpress/core";
import { AlertCircle, ImageOff, LoaderCircle, Search, X } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { ZodError } from "zod";
import { imageSrc } from "./api.ts";

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

export function SearchField({
  value,
  onChange,
  label,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <div className="search">
      <Search size={16} aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
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
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
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
