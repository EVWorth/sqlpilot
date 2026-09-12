import { ChevronLeft, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useContextMenu } from "../../hooks/useContextMenu";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";

export function EditorTabs() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const addTab = useEditorStore((s) => s.addTab);
  const renameTab = useEditorStore((s) => s.renameTab);
  const reorderTabs = useEditorStore((s) => s.reorderTabs);
  const closeOtherTabs = useEditorStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useEditorStore((s) => s.closeTabsToRight);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const profiles = useConnectionStore((s) => s.profiles);
  const { contextMenu, showContextMenu } = useContextMenu();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollLeft, setShowScrollLeft] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollLeft(el.scrollLeft > 0);
  }, []);

  useEffect(() => {
    checkOverflow();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkOverflow);
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", checkOverflow);
      ro.disconnect();
    };
  }, [checkOverflow, tabs.length]);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (!activeTabId || !scrollRef.current) return;
    const activeEl = scrollRef.current.querySelector(
      `[data-tab-id="${activeTabId}"]`,
    );
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeTabId]);

  const scrollBy = (delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: "smooth" });
  };

  const handleDoubleClick = (tabId: string, title: string) => {
    setEditingTabId(tabId);
    setEditValue(title);
  };

  const handleRenameConfirm = () => {
    if (editingTabId && editValue.trim()) {
      renameTab(editingTabId, editValue.trim());
    }
    setEditingTabId(null);
    setEditValue("");
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex(index);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      reorderTabs(dragIndex, toIndex);
    }
    setDragIndex(null);
    setDropIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDropIndex(null);
  };

  /** Move focus to a tab by index, wrapping, and make it the active one. */
  const focusTab = useCallback((index: number) => {
    const target = tabs[(index + tabs.length) % tabs.length];
    if (!target) return;
    setActiveTab(target.id);
    // After the re-render that moves the roving tabindex onto it.
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(target.id)}"]`)
        ?.focus();
    });
  }, [tabs, setActiveTab]);

  /**
   * The tab strip's keyboard map.
   *
   * Arrows move, Home and End jump, Delete closes, and Ctrl+Shift+arrow
   * reorders — the one thing that was mouse-only, since dragging is not
   * something everyone can do (#298 F-backlog).
   */
  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    // Renaming: the input's own handler owns the keyboard.
    if (editingTabId === tabs[index]?.id) return;

    const reorder = e.ctrlKey && e.shiftKey;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        // Moving a tab does not wrap: a tab dragged off the left end would
        // land on the right, which is not what anyone meant by "left".
        if (reorder) {
          if (index === 0) break;
          reorderTabs(index, index - 1);
        }
        focusTab(index - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (reorder) {
          if (index === tabs.length - 1) break;
          reorderTabs(index, index + 1);
        }
        focusTab(index + 1);
        break;
      case "Home":
        e.preventDefault();
        focusTab(0);
        break;
      case "End":
        e.preventDefault();
        focusTab(tabs.length - 1);
        break;
      case "Delete":
        e.preventDefault();
        closeTab(tabs[index].id);
        break;
      case "F2":
        e.preventDefault();
        handleDoubleClick(tabs[index].id, tabs[index].title);
        break;
    }
  };

  const queryTabCount = tabs.filter((t) => t.type === "query").length;

  return (
    <div className="flex h-9 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      {showScrollLeft && (
        <button
          type="button"
          aria-label="Scroll tabs left"
          onClick={() => scrollBy(-120)}
          className="flex h-9 w-6 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      )}
      <div
        ref={scrollRef}
        role="tablist"
        aria-label="Open tabs"
        className="flex flex-1 items-center overflow-x-auto scrollbar-none"
      >
        {tabs.map((tab, index) => {
          const conn = activeConnections.find((c) => c.id === tab.connectionId);
          const profile = conn
            ? profiles.find((p) => p.id === conn.profile_id)
            : undefined;
          const tabColor = profile?.color;
          const isProduction = profile?.environment === "production";

          const isActive = activeTabId === tab.id;

          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={isActive}
              // One stop for the whole strip: Tab reaches the tabs, the arrow
              // keys move within them. Tabbing through every open tab to get
              // past the strip is the thing this pattern exists to avoid.
              tabIndex={isActive ? 0 : -1}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(tab.id);
                }
              }}
              onDoubleClick={() => handleDoubleClick(tab.id, tab.title)}
              onContextMenu={(e) => {
                showContextMenu(e, [
                  { label: "Close", onClick: () => closeTab(tab.id) },
                  { label: "Close Others", onClick: () => closeOtherTabs(tab.id) },
                  { label: "Close to the Right", onClick: () => closeTabsToRight(tab.id) },
                ]);
              }}
              className={cn(
                "group relative flex h-9 items-center gap-1.5 border-r border-[var(--color-border)] px-3 text-xs transition-colors",
                isActive
                  ? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
                dragIndex === index && "opacity-50",
              )}
            >
              {/* Color indicator border */}
              {tabColor && (
                <span
                  className="absolute bottom-0 left-0 right-0 h-[3px] rounded-t"
                  style={{ backgroundColor: tabColor }}
                />
              )}
              {/* Drop indicator line */}
              {dropIndex === index && dragIndex !== null && dragIndex !== index && (
                <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-brand-500" />
              )}
              {isProduction && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" title="Production" />}
              {tab.isDirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />}
              {editingTabId === tab.id
                ? (
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleRenameConfirm}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameConfirm();
                      if (e.key === "Escape") {
                        setEditingTabId(null);
                        setEditValue("");
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                    className="w-20 rounded bg-[var(--color-bg-primary)] px-1 py-0.5 text-xs text-[var(--color-text-primary)] outline-none ring-1 ring-brand-500"
                  />
                )
                : <span className="max-w-[120px] truncate">{tab.title}</span>}
              {!(tab.type === "query" && queryTabCount <= 1) && (
                <button
                  type="button"
                  // A span with an onClick could not be reached by keyboard
                  // and announced as nothing. It is also invisible until
                  // hover, so focus has to reveal it too.
                  aria-label={`Close ${tab.title}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="ml-1 rounded p-0.5 opacity-0 hover:bg-[var(--color-bg-tertiary)] focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          aria-label="New query tab"
          onClick={() => addTab()}
          className="flex h-9 w-9 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {contextMenu}
    </div>
  );
}
