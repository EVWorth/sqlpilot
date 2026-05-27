import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAiStore } from "../../stores/aiStore";

type MenuItemDef =
  | { type: "item"; id: string; label: string; shortcut?: string }
  | { type: "separator" };

type MenuDef = { label: string; items: MenuItemDef[] };

const MENUS: MenuDef[] = [
  {
    label: "File",
    items: [
      { type: "item", id: "new-query", label: "New Query Tab", shortcut: "Ctrl+T" },
      { type: "separator" },
      { type: "item", id: "import", label: "Import Data…" },
      { type: "item", id: "backup", label: "Backup Database…" },
      { type: "item", id: "restore", label: "Restore Database…" },
      { type: "separator" },
      { type: "item", id: "quit", label: "Quit" },
    ],
  },
  {
    label: "Edit",
    items: [
      { type: "item", id: "undo", label: "Undo", shortcut: "Ctrl+Z" },
      { type: "item", id: "redo", label: "Redo", shortcut: "Ctrl+Y" },
      { type: "separator" },
      { type: "item", id: "cut", label: "Cut", shortcut: "Ctrl+X" },
      { type: "item", id: "copy", label: "Copy", shortcut: "Ctrl+C" },
      { type: "item", id: "paste", label: "Paste", shortcut: "Ctrl+V" },
      { type: "item", id: "select-all", label: "Select All", shortcut: "Ctrl+A" },
      { type: "separator" },
      { type: "item", id: "find", label: "Find", shortcut: "Ctrl+F" },
      { type: "item", id: "find-replace", label: "Find & Replace", shortcut: "Ctrl+H" },
    ],
  },
  {
    label: "Connection",
    items: [
      { type: "item", id: "new-connection", label: "New Connection…" },
      { type: "separator" },
      { type: "item", id: "disconnect", label: "Disconnect" },
    ],
  },
  {
    label: "Database",
    items: [
      { type: "item", id: "refresh-schema", label: "Refresh Schema", shortcut: "F5" },
      { type: "separator" },
      { type: "item", id: "query-builder", label: "Visual Query Builder" },
      { type: "item", id: "compare-schemas", label: "Compare Schemas" },
      { type: "separator" },
      { type: "item", id: "admin-tools", label: "Admin Tools" },
    ],
  },
  {
    label: "Help",
    items: [
      { type: "item", id: "keyboard-shortcuts", label: "Keyboard Shortcuts", shortcut: "F1" },
      { type: "separator" },
      { type: "item", id: "about", label: "About SQLPilot" },
    ],
  },
];

function aiToolsMenu(aiEnabled: boolean): MenuDef {
  return {
    label: "Tools",
    items: [
      { type: "item", id: "format-sql", label: "Format SQL", shortcut: "Ctrl+Shift+F" },
      ...(aiEnabled
        ? [{ type: "separator" as const }, { type: "item" as const, id: "ai-assistant", label: "AI Assistant" }]
        : []),
    ],
  };
}

export function MenuBar() {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const aiEnabled = useAiStore((s) => s.aiEnabled);

  const menus = useMemo(() => {
    const m = [...MENUS];
    m.splice(4, 0, aiToolsMenu(aiEnabled));
    return m;
  }, [aiEnabled]);

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
    window.dispatchEvent(new CustomEvent("menu-action", { detail: id }));
  }, []);

  return (
    <div ref={barRef} className="flex items-center">
      {menus.map((menu, idx) => (
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
              {menu.items.map((item, i) =>
                item.type === "separator" ? (
                  <div key={i} className="my-1 h-px bg-[var(--color-border)]" />
                ) : (
                  <button
                    key={item.id}
                    onClick={() => handleItemClick(item.id)}
                    className="flex w-full items-center justify-between gap-8 px-3 py-1 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <span className="shrink-0 text-[var(--color-text-muted)]">{item.shortcut}</span>
                    )}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
