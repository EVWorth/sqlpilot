import { Loader2, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runStatement } from "../../lib/run-statement";
import { computeMetrics, getStatusVal, type RefreshInterval, type StatusSample, type StatusVar } from "./serverStatus";

export function ServerStatusTab({ connectionId }: { connectionId: string }) {
  const [statusVars, setStatusVars] = useState<StatusVar[]>([]);
  // The reading before this one, so QPS can be a rate over the interval rather
  // than the average since the server started (#443).
  const [previousSample, setPreviousSample] = useState<StatusSample | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const results = await runStatement({
        connectionId,
        sql: "SHOW GLOBAL STATUS",
        // A read the app makes on the user's behalf. Recorded so it can be
        // found when something looks odd, hidden unless asked for (#586).
        origin: "internal",
      });
      if (results.length > 0) {
        const rows = results[0].rows.map((row) => ({
          name: String(row[0] ?? ""),
          value: String(row[1] ?? ""),
        }));
        setStatusVars((prior) => {
          // Carry the reading being replaced forward as the baseline.
          if (prior.length > 0) {
            setPreviousSample({
              queries: getStatusVal(prior, "Queries"),
              uptime: getStatusVal(prior, "Uptime"),
            });
          }
          return rows;
        });
        setError(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    setLoading(true);
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (refreshInterval > 0) {
      intervalRef.current = setInterval(fetchStatus, refreshInterval * 1000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refreshInterval, fetchStatus]);

  const metrics = useMemo(
    () => computeMetrics(statusVars, previousSample),
    [statusVars, previousSample],
  );

  const filtered = useMemo(() => {
    if (!filter) return statusVars;
    const lc = filter.toLowerCase();
    return statusVars.filter((v) => v.name.toLowerCase().includes(lc) || v.value.toLowerCase().includes(lc));
  }, [statusVars, filter]);

  if (loading && statusVars.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--color-text-muted)]" />
        <span className="ml-2 text-sm text-[var(--color-text-muted)]">Loading status…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {error && <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">{error}
      </div>}

      {/* Metric Cards */}
      <div className="grid grid-cols-2 gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 sm:grid-cols-4 lg:grid-cols-7">
        {metrics.map((m) => (
          <div
            key={m.label}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2"
          >
            <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              {m.label}
            </div>
            <div className="mt-0.5 text-sm font-semibold text-[var(--color-text-primary)]">{m.value}</div>
            {m.sub && <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{m.sub}</div>}
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter status variables…"
            className="h-7 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] pl-7 pr-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-brand-500 focus:outline-none"
          />
        </div>
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
          onClick={fetchStatus}
          title="Refresh"
          className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Full status table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="sticky top-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-secondary)]">
              <th className="px-3 py-2">Variable Name</th>
              <th className="px-3 py-2">Value</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => (
              <tr
                key={v.name}
                className="border-b border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
              >
                <td className="px-3 py-1.5 font-mono">{v.name}</td>
                <td className="px-3 py-1.5 font-mono text-[var(--color-text-secondary)]">{v.value}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-[var(--color-text-muted)]">
                  No status variables match the filter
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
