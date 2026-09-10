import { Clock, Search, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryEntry } from "../../lib/bindings";
import { api } from "../../lib/tauri-api";

/**
 * A searchable history picker over the editor.
 *
 * The moment you want a previous statement is while typing, and getting it
 * meant leaving the keyboard for the sidebar (#591). DataGrip binds a popup in
 * the editor for exactly this.
 *
 * It reads the history directly rather than through `historyStore`, because
 * the panel's own filters and sort belong to the panel. Someone reaching for
 * a statement mid-thought wants the whole history, not whatever slice the
 * sidebar happens to be showing.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the chosen statement. */
  onPick: (sql: string) => void;
}

/** How many to show. Enough to scroll, few enough to stay a picker. */
const RESULT_LIMIT = 50;

export function HistoryQuickOpen({ isOpen, onClose, onPick }: Props) {
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A generation counter, so a slow read cannot replace a newer one's results.
  const generation = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setSearch("");
    setSelected(0);
    setError(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const mine = ++generation.current;

    void (async () => {
      try {
        const found = await api.historyList({
          search: search.trim() || null,
          connectionNames: null,
          databases: null,
          // Everything, including what the app ran: someone reaching for a
          // statement wants whatever actually ran (#586).
          origins: null,
          status: null,
          executedAfter: null,
          executedBefore: null,
          minDurationMs: null,
          sort: "recent",
          limit: RESULT_LIMIT,
          offset: null,
        });
        if (mine !== generation.current) return;
        setEntries(found);
        setSelected(0);
      } catch (e) {
        if (mine !== generation.current) return;
        setError(`Could not read query history: ${String(e)}`);
      }
    })();
  }, [isOpen, search]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Keep the highlighted row on screen when arrowing past the fold. Called
  // through an optional guard because scrollIntoView is not universal — jsdom
  // has no layout and does not implement it, and losing the scroll is a far
  // better outcome than the picker throwing.
  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-index="${selected}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const chosen = useMemo(() => entries[selected], [entries, selected]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, entries.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Nothing highlighted means nothing matched. Inserting the search text
      // would be a surprising thing to do with it.
      if (!chosen) return;
      onPick(chosen.sql);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Query history"
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search query history…"
            aria-label="Search query history"
            className="w-full bg-transparent text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none"
          />
        </div>

        {error && <p role="alert" className="px-3 py-2 text-[11px] text-red-400">{error}</p>}

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {entries.length === 0
            ? (
              <p className="px-3 py-4 text-center text-[11px] text-[var(--color-text-muted)]">
                {search.trim() ? "No matches" : "No history yet"}
              </p>
            )
            : (
              entries.map((entry, index) => (
                <button
                  key={entry.id}
                  data-index={index}
                  aria-selected={index === selected}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => {
                    onPick(entry.sql);
                    onClose();
                  }}
                  className={`flex w-full flex-col gap-0.5 border-b border-[var(--color-border)] px-3 py-1.5 text-left ${
                    index === selected ? "bg-[var(--color-bg-tertiary)]" : ""
                  }`}
                >
                  <pre className="line-clamp-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-tight text-[var(--color-text-primary)]">
                    {entry.sql}
                  </pre>
                  <span className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                    {entry.status === "error" && <XCircle className="h-2.5 w-2.5 text-red-400" />}
                    <span className="truncate">{entry.connectionName}</span>
                    <span className="flex items-center gap-0.5">
                      <Clock className="h-2.5 w-2.5" />
                      {entry.executionTimeMs}ms
                    </span>
                    {entry.redacted && <span>credential removed</span>}
                  </span>
                </button>
              ))
            )}
        </div>

        <p className="border-t border-[var(--color-border)] px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
          ↑↓ to move · Enter to insert · Esc to close
        </p>
      </div>
    </div>
  );
}
