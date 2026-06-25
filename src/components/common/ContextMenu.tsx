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
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
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
