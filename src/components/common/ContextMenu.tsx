import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

/** A line between groups. Carries nothing, because it does nothing. */
export interface MenuSeparator {
  separator: true;
}

/** Something the user can pick. */
export interface MenuAction {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Hover text. A disabled item is otherwise silent about why. */
  title?: string;
  separator?: false;
}

/**
 * An entry in a context menu.
 *
 * A union rather than one interface with an optional `separator`, which made
 * every separator carry a meaningless label and an empty onClick — twelve
 * copies of `{ separator: true }` across the app
 * (#336). A separator now needs neither, and the type says why: it is not a
 * thing you can click.
 *
 * Separators render as a `<div>`, never a button, so they were not the focus
 * traps the issue supposed. The no-op handlers were noise, not a bug — the
 * fix is to stop writing them, not to guard against them.
 */
export type MenuItem = MenuSeparator | MenuAction;

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** The menu's items that can take focus, in order. */
function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") ?? []);
}

/**
 * A right-click menu, usable from the keyboard too (#823).
 *
 * It opened with focus left on whatever was right-clicked, so Shift+F10 or
 * the context-menu key showed a menu that only a mouse could use. It is now
 * a WAI-ARIA menu: the first enabled item takes focus on open, Up, Down, Home
 * and End move between items, Enter picks one, and Escape or Tab closes it.
 * Focus goes back to what opened it unless the chosen action moved it on.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when the menu opened: the row that was right-clicked,
  // or the one Shift+F10 was pressed on. Read before the menu takes focus.
  const openerRef = useRef<Element | null>(null);
  if (openerRef.current === null && typeof document !== "undefined") {
    openerRef.current = document.activeElement;
  }

  useLayoutEffect(() => {
    enabledItems(menuRef.current)[0]?.focus();
  }, [items]);

  useEffect(() => {
    const menu = menuRef.current;
    return () => {
      // Only if focus would otherwise be lost: an action that opened a dialog
      // or a tab and focused it has put focus where it belongs.
      const active = document.activeElement;
      const lost = !active || active === document.body || (menu?.contains(active) ?? false);
      const opener = openerRef.current;
      if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = enabledItems(menuRef.current);
    const at = all.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    switch (e.key) {
      case "ArrowDown":
        next = all[(at + 1) % all.length];
        break;
      case "ArrowUp":
        next = all[(at - 1 + all.length) % all.length];
        break;
      case "Home":
        next = all[0];
        break;
      case "End":
        next = all[all.length - 1];
        break;
      case "Tab":
        // A menu is not a stop on the way through the page: Tab leaves it,
        // back to where it was opened.
        e.preventDefault();
        onClose();
        return;
      default:
        return;
    }
    e.preventDefault();
    next?.focus();
  };

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (rect.right > vw) {
      el.style.left = `${Math.max(0, x - rect.width)}px`;
    }
    if (rect.bottom > vh) {
      el.style.top = `${Math.max(0, y - rect.height)}px`;
    }
  }, [x, y]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Scroll/resize/visibilitychange: the menu is anchored to absolute x,y
    // coordinates from the original right-click. Any of these events means
    // the menu is visually stale (offscreen while the user keeps scrolling,
    // window resizes, or the OS hides the tab). Auto-close so the menu
    // doesn't survive orphaned. (refs issue #455)
    const handleScroll = () => onClose();
    const handleResize = () => onClose();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") onClose();
    };

    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      className="fixed z-50 min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] py-1 shadow-xl"
      style={{ left: x, top: y }}
    >
      {items.map((item, idx) =>
        item.separator
          ? (
            <div
              key={idx}
              role="separator"
              className="mx-2 my-1 border-t border-[var(--color-border)]"
            />
          )
          : (
            <button
              key={idx}
              role="menuitem"
              // Reached with the arrow keys, not Tab.
              tabIndex={-1}
              disabled={item.disabled}
              aria-disabled={item.disabled || undefined}
              title={item.title}
              onClick={() => {
                if (!item.disabled) {
                  item.onClick();
                  onClose();
                }
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                item.disabled
                  ? "cursor-default text-[var(--color-text-muted)] opacity-50"
                  : item.danger
                  ? "text-[var(--color-error)] hover:surface-error focus:surface-error"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)] focus:bg-[var(--color-bg-secondary)] focus:text-[var(--color-text-primary)]",
              )}
            >
              {item.icon && <span className="h-3.5 w-3.5">{item.icon}</span>}
              {item.label}
            </button>
          )
      )}
    </div>,
    document.body,
  );
}
