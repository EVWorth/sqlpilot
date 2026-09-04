import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /** Hover text. A disabled item is otherwise silent about why. */
  title?: string;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

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
      className="fixed z-50 min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] py-1 shadow-xl"
      style={{ left: x, top: y }}
    >
      {items.map((item, idx) =>
        item.separator
          ? (
            <div
              key={idx}
              className="mx-2 my-1 border-t border-[var(--color-border)]"
            />
          )
          : (
            <button
              key={idx}
              disabled={item.disabled}
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
                  ? "text-red-400 hover:bg-red-500/10"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]",
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
