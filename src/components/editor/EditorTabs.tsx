import { useState, useRef, useEffect, useCallback } from "react";
import { Plus, X, ChevronLeft, ChevronRight } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { cn } from "../../lib/utils";

export function EditorTabs() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const addTab = useEditorStore((s) => s.addTab);
  const renameTab = useEditorStore((s) => s.renameTab);
  const reorderTabs = useEditorStore((s) => s.reorderTabs);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollLeft, setShowScrollLeft] = useState(false);
  const [showScrollRight, setShowScrollRight] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollLeft(el.scrollLeft > 0);
    setShowScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
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

  return (
    <div className="flex h-9 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      {showScrollLeft && (
        <button
          onClick={() => scrollBy(-120)}
          className="flex h-9 w-6 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      )}
      <div
        ref={scrollRef}
        className="flex flex-1 items-center overflow-x-auto scrollbar-none"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
            onClick={() => setActiveTab(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.id);
              }
            }}
            onDoubleClick={() => handleDoubleClick(tab.id, tab.title)}
            className={cn(
              "group relative flex h-9 items-center gap-1.5 border-r border-[var(--color-border)] px-3 text-xs transition-colors",
              activeTabId === tab.id
                ? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
              dragIndex === index && "opacity-50",
            )}
          >
            {/* Drop indicator line */}
            {dropIndex === index && dragIndex !== null && dragIndex !== index && (
              <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-brand-500" />
            )}
            {tab.isDirty && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
            )}
            {editingTabId === tab.id ? (
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
            ) : (
              <span className="max-w-[120px] truncate">{tab.title}</span>
            )}
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="ml-1 rounded p-0.5 opacity-0 hover:bg-[var(--color-bg-tertiary)] group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        ))}
      </div>
      {showScrollRight && (
        <button
          onClick={() => scrollBy(120)}
          className="flex h-9 w-6 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        onClick={() => addTab()}
        className="flex h-9 w-9 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
