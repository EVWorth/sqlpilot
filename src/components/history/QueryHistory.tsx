import { CheckCircle, Clock, Search, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useEditorStore } from "../../stores/editorStore";
import { HISTORY_LIMITS, type HistoryEntry, useHistoryStore } from "../../stores/historyStore";

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function QueryHistory() {
  const entries = useHistoryStore((s) => s.entries);
  const clearHistory = useHistoryStore((s) => s.clearHistory);
  const limit = useHistoryStore((s) => s.limit);
  const setLimit = useHistoryStore((s) => s.setLimit);
  const loading = useHistoryStore((s) => s.loading);
  const storeError = useHistoryStore((s) => s.error);
  const search = useHistoryStore((s) => s.search);
  const setSearch = useHistoryStore((s) => s.setSearch);
  const load = useHistoryStore((s) => s.load);

  // Entries come from the database now, so the panel has to ask for them.
  useEffect(() => {
    void load();
  }, [load]);
  const [confirmClear, setConfirmClear] = useState(false);
  // Failure messages are one line until asked for. A long one would push the
  // rest of the list off the panel, and the entry the user wants is usually
  // identified by its SQL, not by the wording of the error.
  const [expandedError, setExpandedError] = useState<string | null>(null);

  // Filtering is a WHERE clause now rather than an array scan, so `entries`
  // already holds only what matches.
  const handleClick = (entry: HistoryEntry) => {
    const store = useEditorStore.getState();
    const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
    if (activeTab) {
      store.updateTabContent(activeTab.id, entry.sql);
    } else {
      const tabId = store.addTab();
      store.updateTabContent(tabId, entry.sql);
    }
  };

  const handleClear = () => {
    if (confirmClear) {
      void clearHistory();
      setConfirmClear(false);
    } else {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
    }
  };

  const handleRemove = (e: React.MouseEvent, entryId: string) => {
    e.stopPropagation();
    void useHistoryStore.getState().removeEntry(entryId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            placeholder="Search history..."
            value={search}
            onChange={(e) => void setSearch(e.target.value)}
            className="w-full rounded bg-[var(--color-bg-primary)] py-1 pl-6 pr-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
          />
        </div>
        <button
          onClick={handleClear}
          className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-red-400"
          title={confirmClear ? "Click again to confirm" : "Clear history"}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        {confirmClear && <span className="text-[10px] text-red-400">Confirm?</span>}
      </div>

      {
        /* Retention. Lives here rather than in a settings dialog because it is
          about this panel, and the count it governs is on screen next to it. */
      }
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
        <label htmlFor="history-limit">Keep</label>
        <select
          id="history-limit"
          value={limit}
          onChange={(e) => void setLimit(Number(e.target.value))}
          className="rounded bg-[var(--color-bg-primary)] px-1 py-0.5 text-[10px] text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
        >
          {HISTORY_LIMITS.map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString()}
            </option>
          ))}
        </select>
        <span>queries</span>
        <span className="ml-auto">{entries.length.toLocaleString()} shown</span>
      </div>

      {storeError && (
        <p role="alert" className="border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-red-400">
          {storeError}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading
          ? (
            <p className="p-3 text-center text-[11px] text-[var(--color-text-muted)]">
              Loading history…
            </p>
          )
          : entries.length === 0
          ? (
            <p className="p-3 text-center text-[11px] text-[var(--color-text-muted)]">
              {search.trim() ? "No matches" : "No history yet"}
            </p>
          )
          : (
            entries.map((entry) => (
              <button
                key={entry.id}
                onClick={() => handleClick(entry)}
                className="group flex w-full flex-col gap-0.5 border-b border-[var(--color-border)] px-2.5 py-2 text-left hover:bg-[var(--color-bg-tertiary)]"
              >
                <div className="flex items-start justify-between gap-1">
                  <pre className="line-clamp-2 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-tight text-[var(--color-text-primary)]">
                    {entry.sql}
                  </pre>
                  <span
                    role="button"
                    aria-label="Delete entry"
                    title="Delete entry"
                    onClick={(e) => handleRemove(e, entry.id)}
                    className="inline-flex shrink-0 cursor-pointer rounded p-0.5 text-[var(--color-text-muted)] opacity-0 hover:bg-[var(--color-bg-secondary)] hover:text-red-400 group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                  {entry.status === "success"
                    ? <CheckCircle className="h-3 w-3 text-green-400" />
                    : <XCircle className="h-3 w-3 text-red-400" />}
                  <span className="truncate">{entry.connectionName}</span>
                  <span className="flex items-center gap-0.5">
                    <Clock className="h-2.5 w-2.5" />
                    {formatRelativeTime(entry.executedAt)}
                  </span>
                  <span>{entry.executionTimeMs}ms</span>
                  {entry.status === "success" && <span>{entry.rowCount} rows</span>}
                  {entry.redacted && (
                    <span
                      className="rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px] uppercase tracking-wide"
                      title="A password was removed before this was saved, so it will not run as written."
                    >
                      redacted
                    </span>
                  )}
                  {entry.status === "error" && entry.errorCode !== undefined && (
                    <span className="font-mono text-red-400/80">
                      {entry.errorCode}
                      {entry.errorSqlState ? ` · ${entry.errorSqlState}` : ""}
                    </span>
                  )}
                </div>
                {entry.status === "error" && entry.error && (
                  <span
                    role="button"
                    aria-expanded={expandedError === entry.id}
                    title={entry.error}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedError((prev) => (prev === entry.id ? null : entry.id));
                    }}
                    className={`cursor-pointer text-[10px] text-red-400 ${
                      expandedError === entry.id ? "whitespace-pre-wrap break-words" : "truncate"
                    }`}
                  >
                    {entry.error}
                  </span>
                )}
              </button>
            ))
          )}
      </div>
    </div>
  );
}
