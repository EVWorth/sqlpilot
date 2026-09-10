import {
  CheckCircle,
  Clock,
  Download,
  FileText,
  Play,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useContextMenu } from "../../hooks/useContextMenu";
import { groupConsecutive } from "../../lib/history-grouping";
import { api } from "../../lib/tauri-api";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import {
  hasActiveFilters,
  HISTORY_LIMITS,
  HISTORY_MAX_AGE_DAYS,
  type HistoryEntry,
  type HistoryExportFormat,
  type HistorySort,
  useHistoryStore,
} from "../../stores/historyStore";
import { useResultStore } from "../../stores/resultStore";

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

/** Shared class for the small filter controls, so they line up. */
const CONTROL =
  "rounded bg-[var(--color-bg-primary)] px-1 py-0.5 text-[10px] text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500";

/** A row of toggleable values — connections, databases. */
function FilterChips(
  { label, options, selected, onToggle }: {
    label: string;
    options: string[];
    selected: string[];
    onToggle: (value: string) => void;
  },
) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span>{label}</span>
      {options.map((option) => {
        const on = selected.includes(option);
        return (
          <button
            key={option}
            onClick={() => onToggle(option)}
            aria-pressed={on}
            className={`max-w-[10rem] truncate rounded px-1.5 py-0.5 text-[10px] ring-1 ${
              on
                ? "bg-brand-600/20 text-brand-300 ring-brand-500"
                : "text-[var(--color-text-muted)] ring-[var(--color-border)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function QueryHistory() {
  const entries = useHistoryStore((s) => s.entries);
  const clearHistory = useHistoryStore((s) => s.clearHistory);
  const limit = useHistoryStore((s) => s.limit);
  const setLimit = useHistoryStore((s) => s.setLimit);
  const maxAgeDays = useHistoryStore((s) => s.maxAgeDays);
  const redactLiterals = useHistoryStore((s) => s.redactLiterals);
  const setRedactLiterals = useHistoryStore((s) => s.setRedactLiterals);
  const setMaxAgeDays = useHistoryStore((s) => s.setMaxAgeDays);
  const loading = useHistoryStore((s) => s.loading);
  const storeError = useHistoryStore((s) => s.error);
  const filters = useHistoryStore((s) => s.filters);
  const setFilters = useHistoryStore((s) => s.setFilters);
  const resetFilters = useHistoryStore((s) => s.resetFilters);
  const matchCount = useHistoryStore((s) => s.matchCount);
  const facets = useHistoryStore((s) => s.facets);
  const exportMatching = useHistoryStore((s) => s.exportMatching);
  const load = useHistoryStore((s) => s.load);

  const { contextMenu, showContextMenu } = useContextMenu();
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Entries come from the database now, so the panel has to ask for them.
  useEffect(() => {
    void load();
  }, [load]);

  const active = hasActiveFilters(filters);
  // Sorting by anything other than recency makes adjacency meaningless, so
  // there is nothing sensible to collapse (#590).
  const rows = useMemo(
    () => filters.sort === "recent" ? groupConsecutive(entries) : entries.map((e) => ({ entry: e, runs: [e] })),
    [entries, filters.sort],
  );
  const [confirmClear, setConfirmClear] = useState(false);
  // Failure messages are one line until asked for. A long one would push the
  // rest of the list off the panel, and the entry the user wants is usually
  // identified by its SQL, not by the wording of the error.
  const [expandedError, setExpandedError] = useState<string | null>(null);

  // Filtering is a WHERE clause now rather than an array scan, so `entries`
  // already holds only what matches.
  /** Put the statement in the active tab, opening one if there is none. */
  const insertIntoEditor = (entry: HistoryEntry): string => {
    const store = useEditorStore.getState();
    const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
    if (activeTab) {
      store.updateTabContent(activeTab.id, entry.sql);
      return activeTab.id;
    }
    const tabId = store.addTab();
    store.updateTabContent(tabId, entry.sql);
    return tabId;
  };

  const handleClick = (entry: HistoryEntry) => {
    insertIntoEditor(entry);
  };

  /**
   * The live connection this entry came from, if it is still open.
   *
   * Entries record the connection's name rather than its id — an id is a
   * per-session UUID and would stop resolving the moment the app restarted,
   * which is exactly when someone reaches for an old entry.
   */
  const liveConnectionFor = (entry: HistoryEntry) =>
    useConnectionStore
      .getState()
      .activeConnections.find((c) => c.name === entry.connectionName);

  /**
   * Insert and run, which is the half of FR-9.1.4 that was never built (#325).
   *
   * Runs against the connection the entry came from, not whichever one happens
   * to be selected: rerunning yesterday's staging query against production
   * because the sidebar moved on is the mistake worth designing out.
   */
  const handleRunNow = async (entry: HistoryEntry) => {
    const connection = liveConnectionFor(entry);
    if (!connection) {
      useHistoryStore.setState({
        error: `${entry.connectionName} is not connected, so this cannot be run from here.`,
      });
      return;
    }

    const tabId = insertIntoEditor(entry);
    useEditorStore.getState().setActiveTab(tabId);
    await useResultStore.getState().executeQuery(
      connection.id,
      entry.sql,
      entry.database ?? undefined,
    );
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

  const handleExport = async (format: HistoryExportFormat) => {
    setExporting(true);
    try {
      const contents = await exportMatching(format);
      const path = await api.pickSaveFile(
        "Export query history",
        format === "csv" ? "query-history.csv" : "query-history.sql",
        [[format === "csv" ? "CSV" : "SQL", [format]]],
      );
      // A cancelled save dialog is not a failure; it is the user changing
      // their mind, and saying nothing is the right response.
      if (path) await api.writeFileContents(path, contents);
    } catch (e) {
      useHistoryStore.setState({ error: `Could not export history: ${String(e)}` });
    } finally {
      setExporting(false);
    }
  };

  /** Add or remove one value from a multi-select filter. */
  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

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
            value={filters.search}
            onChange={(e) => void setFilters({ search: e.target.value })}
            className="w-full rounded bg-[var(--color-bg-primary)] py-1 pl-6 pr-2 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
          />
        </div>
        <button
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          className={`rounded p-1 hover:bg-[var(--color-bg-tertiary)] ${
            active ? "text-brand-400" : "text-[var(--color-text-muted)]"
          }`}
          title={active ? "Filters (active)" : "Filters"}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={handleClear}
          className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-red-400"
          title={confirmClear ? "Click again to confirm" : "Clear history"}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        {confirmClear && <span className="text-[10px] text-red-400">Confirm?</span>}
      </div>

      {showFilters && (
        <div className="space-y-1.5 border-b border-[var(--color-border)] px-2 py-2 text-[10px] text-[var(--color-text-muted)]">
          <div className="flex items-center gap-1">
            <label htmlFor="history-sort">Sort</label>
            <select
              id="history-sort"
              value={filters.sort}
              onChange={(e) => void setFilters({ sort: e.target.value as HistorySort })}
              className={CONTROL}
            >
              <option value="recent">Most recent</option>
              <option value="slowest">Slowest first</option>
              <option value="most_rows">Most rows</option>
            </select>

            <label htmlFor="history-status" className="ml-2">Status</label>
            <select
              id="history-status"
              value={filters.status}
              onChange={(e) => void setFilters({ status: e.target.value })}
              className={CONTROL}
            >
              <option value="">Any</option>
              <option value="success">Succeeded</option>
              <option value="error">Failed</option>
            </select>
          </div>

          <div className="flex items-center gap-1">
            <label htmlFor="history-after">From</label>
            <input
              id="history-after"
              type="date"
              value={filters.executedAfter.slice(0, 10)}
              onChange={(e) =>
                void setFilters({
                  executedAfter: e.target.value ? `${e.target.value}T00:00:00Z` : "",
                })}
              className={CONTROL}
            />
            <label htmlFor="history-before">to</label>
            <input
              id="history-before"
              type="date"
              value={filters.executedBefore.slice(0, 10)}
              onChange={(e) =>
                // End of day, so "to the 3rd" includes the 3rd rather than
                // stopping at midnight before it.
                void setFilters({
                  executedBefore: e.target.value ? `${e.target.value}T23:59:59Z` : "",
                })}
              className={CONTROL}
            />
          </div>

          <div className="flex items-center gap-1">
            <label htmlFor="history-slower">Slower than</label>
            <input
              id="history-slower"
              type="number"
              min={0}
              step={100}
              value={filters.minDurationMs ?? ""}
              onChange={(e) =>
                void setFilters({
                  minDurationMs: e.target.value === "" ? null : Number(e.target.value),
                })}
              className={`${CONTROL} w-16`}
            />
            <span>ms</span>
          </div>

          {facets.connectionNames.length > 0 && (
            <FilterChips
              label="Connections"
              options={facets.connectionNames}
              selected={filters.connectionNames}
              onToggle={(v) => void setFilters({ connectionNames: toggleIn(filters.connectionNames, v) })}
            />
          )}
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={redactLiterals}
              onChange={(e) => setRedactLiterals(e.target.checked)}
              className="h-3 w-3 accent-brand-500"
            />
            {
              /* Off by default: a redacted entry cannot be rerun and is much
                harder to read, which is most of what history is for. This is
                for shared or regulated machines (#330). */
            }
            <span title="Applies to entries recorded from now on, not to ones already stored.">
              Hide values in new entries
            </span>
          </label>

          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={filters.includeAppOrigins}
              onChange={(e) => void setFilters({ includeAppOrigins: e.target.checked })}
              className="h-3 w-3 accent-brand-500"
            />
            {
              /* Off by default: a thousand-statement dump would otherwise bury
                a day's editing under statements nobody typed (#586). */
            }
            <span>Include imports, restores and internal reads</span>
          </label>

          {facets.databases.length > 0 && (
            <FilterChips
              label="Databases"
              options={facets.databases}
              selected={filters.databases}
              onToggle={(v) => void setFilters({ databases: toggleIn(filters.databases, v) })}
            />
          )}

          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={() => void resetFilters()}
              disabled={!active}
              className="rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
            >
              Reset
            </button>
            <span className="ml-auto">Export what matches:</span>
            <button
              onClick={() => void handleExport("csv")}
              disabled={exporting}
              className="rounded px-1.5 py-0.5 text-[10px] text-brand-400 hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40"
            >
              <Download className="mr-0.5 inline h-2.5 w-2.5" />CSV
            </button>
            <button
              onClick={() => void handleExport("sql")}
              disabled={exporting}
              className="rounded px-1.5 py-0.5 text-[10px] text-brand-400 hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40"
            >
              <Download className="mr-0.5 inline h-2.5 w-2.5" />SQL
            </button>
          </div>
        </div>
      )}

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
        <label htmlFor="history-max-age" className="ml-1">for</label>
        <select
          id="history-max-age"
          value={maxAgeDays}
          onChange={(e) => void setMaxAgeDays(Number(e.target.value))}
          className="rounded bg-[var(--color-bg-primary)] px-1 py-0.5 text-[10px] text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
        >
          {HISTORY_MAX_AGE_DAYS.map((d) => (
            <option key={d} value={d}>
              {d === 0 ? "ever" : `${d} days`}
            </option>
          ))}
        </select>
        {/* "50 of 812": a full page and a last page look identical without it. */}
        <span className="ml-auto">
          {matchCount > entries.length
            ? `${entries.length.toLocaleString()} of ${matchCount.toLocaleString()}`
            : `${entries.length.toLocaleString()} shown`}
        </span>
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
              {filters.search.trim() || active ? "No matches" : "No history yet"}
            </p>
          )
          : (
            rows.map(({ entry, runs }) => (
              <button
                key={entry.id}
                onClick={() => handleClick(entry)}
                onContextMenu={(e) => {
                  const live = liveConnectionFor(entry);
                  showContextMenu(e, [
                    {
                      label: "Insert into editor",
                      icon: <FileText className="h-3.5 w-3.5" />,
                      onClick: () => handleClick(entry),
                    },
                    {
                      label: live
                        ? `Run now on ${entry.connectionName}`
                        : "Run now",
                      icon: <Play className="h-3.5 w-3.5" />,
                      // A redacted entry is missing the password it needs, so
                      // running it would fail in a way nobody could act on
                      // (#587).
                      disabled: !live || entry.redacted,
                      title: entry.redacted
                        ? "A credential was removed from this entry, so it will not run as written."
                        : live
                        ? undefined
                        : `${entry.connectionName} is not connected.`,
                      onClick: () => void handleRunNow(entry),
                    },
                    { separator: true },
                    {
                      label: "Delete",
                      icon: <Trash2 className="h-3.5 w-3.5" />,
                      danger: true,
                      onClick: () => void useHistoryStore.getState().removeEntry(entry.id),
                    },
                  ]);
                }}
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
                  {entry.origin !== "editor" && (
                    <span
                      className="rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px]"
                      title={`Issued by the ${entry.origin}`}
                    >
                      {entry.origin}
                    </span>
                  )}
                  {runs.length > 1 && (
                    <span
                      className="rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px]"
                      title={`Run ${runs.length} times in a row`}
                    >
                      ×{runs.length}
                    </span>
                  )}
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
      {contextMenu}
    </div>
  );
}
