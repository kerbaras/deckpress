import { ChevronDown } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface MenuAction {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  disabledReason?: string | undefined;
  onSelect: () => void;
}

const nextIndex = (key: string, index: number, count: number) => {
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
};

const menuItems = (menu: HTMLElement | null) => [
  ...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
];

export function MenuButton({
  label,
  items,
}: {
  label: string;
  items: MenuAction[];
}) {
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const open = focusIndex !== null;
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (focusIndex !== null) menuItems(menu.current)[focusIndex]?.focus();
  }, [focusIndex]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target))
        setFocusIndex(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  const close = (fromKeyboard: boolean) => {
    setFocusIndex(null);
    if (button.current && fromKeyboard) button.current.dataset.focusReturn = "";
    button.current?.focus();
  };
  const clearFocusReturn = () => {
    delete button.current?.dataset.focusReturn;
  };
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setFocusIndex(event.key === "ArrowDown" ? 0 : items.length - 1);
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      button.current?.focus();
      setFocusIndex(null);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const all = menuItems(menu.current);
    const current = all.indexOf(document.activeElement as HTMLElement);
    const next = nextIndex(event.key, current, all.length);
    if (next === null) return;
    event.preventDefault();
    all[next]?.focus();
  };
  return (
    <div className="menu-anchor">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => setFocusIndex(open ? null : 0)}
        onKeyDown={onButtonKey}
        onPointerDown={clearFocusReturn}
        onBlur={clearFocusReturn}
      >
        {label}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menu}
          id={`${id}-menu`}
          className="menu"
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onMenuKey}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={item.disabledReason ? true : undefined}
              aria-labelledby={`${id}-${item.id}`}
              aria-describedby={`${id}-${item.id}-hint`}
              onClick={(event) => {
                if (item.disabledReason) return;
                close(event.detail === 0);
                item.onSelect();
              }}
            >
              {item.icon}
              <span id={`${id}-${item.id}`} className="menu-item-label">
                {item.label}
              </span>
              <span id={`${id}-${item.id}-hint`} className="menu-item-hint">
                {item.disabledReason ?? item.hint}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
