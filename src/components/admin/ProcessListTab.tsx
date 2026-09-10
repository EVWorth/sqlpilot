import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search, Skull } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import type { ProcessInfo } from "../../types";
import {
  filterProcesses,
  hasProcessFilters,
  NO_PROCESS_FILTERS,
  processFilterOptions,
  type ProcessFilters,
} from "./processFilter";
import type { RefreshInterval } from "./serverStatus";

export function ProcessListTab({ connectionId }: { connectionId: string }) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ProcessFilters>(NO_PROCESS_FILTERS);
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirmKillId, setConfirmKillId] = useState<number | null>(null);
  // The process list includes the sessions this panel is itself using. Killing
  // one disconnects the app from the server it is managing, and killing the
  // last exhausted the pool and reported "pool timed out" — which does not
  // tell the user what they just did (#433).
  const [ownThreadIds, setOwnThreadIds] = useState<Set<number>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchProcesses = useCallback(async () => {
    try {
      const [data, own] = await Promise.all([
        api.getProcessList(connectionId),
        api.getOwnThreadIds(connectionId),
      ]);
      setProcesses(data);
      setOwnThreadIds(new Set(own));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    setLoading(true);
    fetchProcesses();
  }, [fetchProcesses]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (refreshInterval > 0) {
      intervalRef.current = setInterval(fetchProcesses, refreshInterval * 1000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refreshInterval, fetchProcesses]);

  // Two scopes, because they are not interchangeable: aborting a long SELECT
  // should not also discard the session's transaction, prepared statements and
  // variables, which is all `KILL` could do before (#430).
  const handleKill = async (processId: number, scope: "query" | "connection") => {
    try {
      if (scope === "query") {
        await api.killQuery(connectionId, processId);
      } else {
        await api.killProcess(connectionId, processId);
      }
      setConfirmKillId(null);
      await fetchProcesses();
    } catch (e) {
      setError(
        `Failed to kill ${scope === "query" ? "query on" : "connection"} ${processId}: ${e}`,
      );
    }
  };

  const filtered = useMemo(() => filterProcesses(processes, filters), [processes, filters]);
  // Taken from what is connected, so a dropdown only offers values that would
  // return something.
  const options = useMemo(() => processFilterOptions(processes), [processes]);

  function timeColor(time: number): string {
    if (time < 5) return "text-green-400";
    if (time <= 30) return "text-yellow-400";
    return "text-red-400";
  }

  if (loading && processes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--color-text-muted)]" />
        <span className="ml-2 text-sm text-[var(--color-text-muted)]">Loading processes…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder="Filter processes…"
            className="h-7 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] pl-7 pr-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-brand-500 focus:outline-none"
          />
        </div>
        {([
          ["user", "User", options.users],
          ["database", "Database", options.databases],
          ["state", "State", options.states],
        ] as const).map(([key, label, values]) => (
          <select
            key={key}
            aria-label={label}
            value={filters[key]}
            onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value }))}
            className="h-7 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none"
          >
            <option value="">{label}: any</option>
            {values.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        ))}
        {hasProcessFilters(filters) && (
          <button
            onClick={() => setFilters(NO_PROCESS_FILTERS)}
            className="h-7 rounded px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            Clear
          </button>
        )}
        <select
          value={refreshInterval}
          onChange={(e) => setRefreshInterval(Number(e.target.value) as RefreshInterval)}
          className="h-7 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none"
        >
          <option value={0}>Auto-refresh: Off</option>
          <option value={2}>Every 2s</option>
          <option value={5}>Every 5s</option>
          <option value={10}>Every 10s</option>
        </select>
        <button
          onClick={fetchProcesses}
          title="Refresh"
          className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">{error}
      </div>}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="sticky top-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-secondary)]">
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Host</th>
              <th className="px-3 py-2">Database</th>
              <th className="px-3 py-2">Command</th>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Info</th>
              <th className="w-16 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr
                key={p.id}
                className="border-b border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
              >
                <td className="px-3 py-1.5 font-mono">{p.id}</td>
                <td className="px-3 py-1.5">{p.user}</td>
                <td className="px-3 py-1.5 text-[var(--color-text-muted)]">{p.host}</td>
                <td className="px-3 py-1.5">
                  {p.db ?? <span className="italic text-[var(--color-text-muted)]">NULL</span>}
                </td>
                <td className="px-3 py-1.5">{p.command}</td>
                <td className={cn("px-3 py-1.5 font-mono", timeColor(p.time))}>{p.time}s</td>
                <td className="px-3 py-1.5 text-[var(--color-text-muted)]">{p.state ?? ""}</td>
                <td className="max-w-[300px] px-3 py-1.5">
                  {p.info
                    ? (
                      <button
                        onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                        className="flex items-center gap-1 text-left font-mono text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                      >
                        {expandedId === p.id
                          ? <ChevronDown className="h-3 w-3 shrink-0" />
                          : <ChevronRight className="h-3 w-3 shrink-0" />}
                        <span className={expandedId === p.id ? "whitespace-pre-wrap" : "truncate block max-w-[280px]"}>
                          {p.info}
                        </span>
                      </button>
                    )
                    : <span className="italic text-[var(--color-text-muted)]">—</span>}
                </td>
                <td className="px-3 py-1.5">
                  {confirmKillId === p.id
                    ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleKill(p.id, "query")}
                          title="Abort the running statement, keep the session"
                          className="rounded bg-amber-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-amber-500"
                        >
                          Kill query
                        </button>
                        <button
                          onClick={() => handleKill(p.id, "connection")}
                          title="Disconnect the session entirely, discarding its transaction"
                          className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-red-500"
                        >
                          Kill connection
                        </button>
                        <button
                          onClick={() => setConfirmKillId(null)}
                          className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                        >
                          Cancel
                        </button>
                      </div>
                    )
                    : (
                      <button
                        onClick={() => setConfirmKillId(p.id)}
                        disabled={ownThreadIds.has(p.id)}
                        title={ownThreadIds.has(p.id)
                          ? "This is SQLPilot's own connection to the server — killing it would disconnect the app"
                          : `Kill process ${p.id}`}
                        className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-red-500/20 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-muted)]"
                      >
                        <Skull className="h-3.5 w-3.5" />
                      </button>
                    )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-[var(--color-text-muted)]">
                  {hasProcessFilters(filters) ? "No processes match the filters" : "No active processes"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
