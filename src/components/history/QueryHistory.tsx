import { CheckCircle, Clock, Search, Trash2, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useEditorStore } from "../../stores/editorStore";
import { type HistoryEntry, useHistoryStore } from "../../stores/historyStore";

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
  const [search, setSearch] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter((e) => e.sql.toLowerCase().includes(q));
  }, [entries, search]);

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
      clearHistory();
      setConfirmClear(false);
    } else {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
    }
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
            onChange={(e) => setSearch(e.target.value)}
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

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0
          ? (
            <p className="p-3 text-center text-[11px] text-[var(--color-text-muted)]">
              {entries.length === 0 ? "No history yet" : "No matches"}
            </p>
          )
          : (
            filtered.map((entry) => (
              <button
                key={entry.id}
                onClick={() => handleClick(entry)}
                className="group flex w-full flex-col gap-0.5 border-b border-[var(--color-border)] px-2.5 py-2 text-left hover:bg-[var(--color-bg-tertiary)]"
              >
                <pre className="line-clamp-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-tight text-[var(--color-text-primary)]">
                {entry.sql}
                </pre>
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
                </div>
              </button>
            ))
          )}
      </div>
    </div>
  );
}
