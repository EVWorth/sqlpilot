import { useCallback, useEffect, useRef, useState } from "react";
import { actionById, MENUS, runAction } from "../../lib/actions";

export function MenuBar() {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openMenu === null) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openMenu]);

  const handleItemClick = useCallback((id: string) => {
    setOpenMenu(null);
    runAction(id);
  }, []);

  return (
    <div ref={barRef} className="flex items-center">
      {MENUS.map((menu, idx) => (
        <div key={menu.label} className="relative">
          <button
            onClick={() => setOpenMenu(openMenu === idx ? null : idx)}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              openMenu === idx
                ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {menu.label}
          </button>

          {openMenu === idx && (
            <div className="absolute left-0 top-full z-50 min-w-48 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-lg">
              {menu.entries.map((entry, i) => {
                if (entry.type === "separator") {
                  return <div key={i} className="my-1 h-px bg-[var(--color-border)]" />;
                }
                const action = actionById(entry.id);
                if (!action) return null;
                return (
                  <button
                    key={entry.id}
                    onClick={() => handleItemClick(entry.id)}
                    className="flex w-full items-center justify-between gap-8 px-3 py-1 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <span>{action.label}</span>
                    {action.shortcut && (
                      <span className="shrink-0 text-[var(--color-text-muted)]">{action.shortcut}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
