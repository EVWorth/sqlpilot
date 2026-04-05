import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  RefreshCw,
  Search,
  Skull,
  Copy,
  ChevronDown,
  ChevronRight,
  ArrowUpDown,
  Activity,
  Server,
  List,
  Loader2,
  Check,
  Users,
} from "lucide-react";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import type { ProcessInfo, ServerVariable } from "../../types";
import { UserManagement } from "./UserManagement";

type AdminSubTab = "processes" | "variables" | "status" | "users";

interface AdminPanelProps {
  connectionId: string;
}

export function AdminPanel({ connectionId }: AdminPanelProps) {
  const [activeSubTab, setActiveSubTab] = useState<AdminSubTab>("processes");

  const subTabs: { key: AdminSubTab; label: string; icon: typeof Activity }[] = [
    { key: "processes", label: "Process List", icon: List },
    { key: "variables", label: "Server Variables", icon: Server },
    { key: "status", label: "Server Status", icon: Activity },
    { key: "users", label: "Users", icon: Users },
  ];

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      <div className="flex h-8 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1">
        {subTabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveSubTab(key)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
              activeSubTab === key
                ? "bg-[var(--color-bg-primary)] text-brand-400"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {activeSubTab === "processes" && <ProcessListTab connectionId={connectionId} />}
        {activeSubTab === "variables" && <ServerVariablesTab connectionId={connectionId} />}
        {activeSubTab === "status" && <ServerStatusTab connectionId={connectionId} />}
        {activeSubTab === "users" && <UserManagement connectionId={connectionId} />}
      </div>
    </div>
  );
}

// ─── Process List Tab ──────────────────────────────────────────────────────

type RefreshInterval = 0 | 2 | 5 | 10;

function ProcessListTab({ connectionId }: { connectionId: string }) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirmKillId, setConfirmKillId] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchProcesses = useCallback(async () => {
    try {
      const data = await api.getProcessList(connectionId);
      setProcesses(data);
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

  const handleKill = async (processId: number) => {
    try {
      await api.killProcess(connectionId, processId);
      setConfirmKillId(null);
      await fetchProcesses();
    } catch (e) {
      setError(`Failed to kill process ${processId}: ${e}`);
    }
  };

  const filtered = useMemo(() => {
    if (!filter) return processes;
    const lc = filter.toLowerCase();
    return processes.filter(
      (p) =>
        String(p.id).includes(lc) ||
        p.user.toLowerCase().includes(lc) ||
        p.host.toLowerCase().includes(lc) ||
        (p.db ?? "").toLowerCase().includes(lc) ||
        p.command.toLowerCase().includes(lc) ||
        (p.state ?? "").toLowerCase().includes(lc) ||
        (p.info ?? "").toLowerCase().includes(lc),
    );
  }, [processes, filter]);

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
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter processes…"
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
          onClick={fetchProcesses}
          title="Refresh"
          className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">{error}</div>
      )}

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
                <td className="px-3 py-1.5">{p.db ?? <span className="italic text-[var(--color-text-muted)]">NULL</span>}</td>
                <td className="px-3 py-1.5">{p.command}</td>
                <td className={cn("px-3 py-1.5 font-mono", timeColor(p.time))}>{p.time}s</td>
                <td className="px-3 py-1.5 text-[var(--color-text-muted)]">{p.state ?? ""}</td>
                <td className="max-w-[300px] px-3 py-1.5">
                  {p.info ? (
                    <button
                      onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                      className="flex items-center gap-1 text-left font-mono text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                    >
                      {expandedId === p.id ? (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      )}
                      <span className={expandedId === p.id ? "whitespace-pre-wrap" : "truncate block max-w-[280px]"}>
                        {p.info}
                      </span>
                    </button>
                  ) : (
                    <span className="italic text-[var(--color-text-muted)]">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  {confirmKillId === p.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleKill(p.id)}
                        className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-red-500"
                      >
                        Kill?
                      </button>
                      <button
                        onClick={() => setConfirmKillId(null)}
                        className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmKillId(p.id)}
                      title={`Kill process ${p.id}`}
                      className="rounded p-1 text-[var(--color-text-muted)] hover:bg-red-500/20 hover:text-red-400 transition-colors"
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
                  {filter ? "No processes match the filter" : "No active processes"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Server Variables Tab ──────────────────────────────────────────────────

type SortField = "name" | "value";
type SortDir = "asc" | "desc";

function ServerVariablesTab({ connectionId }: { connectionId: string }) {
  const [variables, setVariables] = useState<ServerVariable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .getServerVariables(connectionId)
      .then((data) => {
        setVariables(data);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [connectionId]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const grouped = useMemo(() => {
    const lc = filter.toLowerCase();
    const filtered = filter
      ? variables.filter((v) => v.name.toLowerCase().includes(lc) || v.value.toLowerCase().includes(lc))
      : variables;

    const sorted = [...filtered].sort((a, b) => {
      const aVal = sortField === "name" ? a.name : a.value;
      const bVal = sortField === "name" ? b.name : b.value;
      const cmp = aVal.localeCompare(bVal);
      return sortDir === "asc" ? cmp : -cmp;
    });

    const groups: Record<string, ServerVariable[]> = {};
    for (const v of sorted) {
      const idx = v.name.indexOf("_");
      const prefix = idx > 0 ? v.name.substring(0, idx) : "other";
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push(v);
    }

    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [variables, filter, sortField, sortDir]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--color-text-muted)]" />
        <span className="ml-2 text-sm text-[var(--color-text-muted)]">Loading variables…</span>
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
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter variables…"
            className="h-7 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] pl-7 pr-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-brand-500 focus:outline-none"
          />
        </div>
        <span className="text-xs text-[var(--color-text-muted)]">
          {variables.length} variables
        </span>
      </div>

      {error && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">{error}</div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="sticky top-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-secondary)]">
              <th
                className="cursor-pointer px-3 py-2 select-none hover:text-[var(--color-text-primary)]"
                onClick={() => handleSort("name")}
              >
                <span className="flex items-center gap-1">
                  Variable Name
                  <ArrowUpDown className="h-3 w-3" />
                </span>
              </th>
              <th
                className="cursor-pointer px-3 py-2 select-none hover:text-[var(--color-text-primary)]"
                onClick={() => handleSort("value")}
              >
                <span className="flex items-center gap-1">
                  Value
                  <ArrowUpDown className="h-3 w-3" />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(([group, vars]) => (
              <GroupRows
                key={group}
                group={group}
                variables={vars}
                collapsed={collapsedGroups.has(group)}
                onToggle={() => toggleGroup(group)}
                onCopy={handleCopy}
                copiedKey={copiedKey}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({
  group,
  variables,
  collapsed,
  onToggle,
  onCopy,
  copiedKey,
}: {
  group: string;
  variables: ServerVariable[];
  collapsed: boolean;
  onToggle: () => void;
  onCopy: (text: string, key: string) => void;
  copiedKey: string | null;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-secondary)]"
        onClick={onToggle}
      >
        <td colSpan={2} className="px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
            {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {group}
            <span className="text-[var(--color-text-muted)]">({variables.length})</span>
          </span>
        </td>
      </tr>
      {!collapsed &&
        variables.map((v) => (
          <tr
            key={v.name}
            className="border-b border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
          >
            <td className="px-3 py-1.5">
              <button
                onClick={() => onCopy(v.name, `name:${v.name}`)}
                className="group flex items-center gap-1 font-mono hover:text-brand-400"
                title="Copy variable name"
              >
                {v.name}
                {copiedKey === `name:${v.name}` ? (
                  <Check className="h-3 w-3 text-green-400" />
                ) : (
                  <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                )}
              </button>
            </td>
            <td className="px-3 py-1.5">
              <button
                onClick={() => onCopy(v.value, `value:${v.name}`)}
                className="group flex items-center gap-1 font-mono text-[var(--color-text-secondary)] hover:text-brand-400"
                title="Copy value"
              >
                <span className="max-w-[600px] truncate">{v.value}</span>
                {copiedKey === `value:${v.name}` ? (
                  <Check className="h-3 w-3 text-green-400" />
                ) : (
                  <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                )}
              </button>
            </td>
          </tr>
        ))}
    </>
  );
}

// ─── Server Status Tab ─────────────────────────────────────────────────────

interface StatusVar {
  name: string;
  value: string;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

function getStatusVal(vars: StatusVar[], name: string): number {
  const v = vars.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return v ? Number(v.value) || 0 : 0;
}

interface MetricCard {
  label: string;
  value: string;
  sub?: string;
}

function computeMetrics(vars: StatusVar[]): MetricCard[] {
  const uptime = getStatusVal(vars, "Uptime");
  const queries = getStatusVal(vars, "Queries");
  const slowQueries = getStatusVal(vars, "Slow_queries");
  const connections = getStatusVal(vars, "Connections");
  const threadsConnected = getStatusVal(vars, "Threads_connected");
  const threadsRunning = getStatusVal(vars, "Threads_running");
  const threadsCached = getStatusVal(vars, "Threads_cached");
  const poolSize = getStatusVal(vars, "Innodb_buffer_pool_pages_total");
  const poolFree = getStatusVal(vars, "Innodb_buffer_pool_pages_free");
  const poolReads = getStatusVal(vars, "Innodb_buffer_pool_reads");
  const poolReadRequests = getStatusVal(vars, "Innodb_buffer_pool_read_requests");
  const openTables = getStatusVal(vars, "Open_tables");
  const openedTables = getStatusVal(vars, "Opened_tables");

  const qps = uptime > 0 ? (queries / uptime).toFixed(1) : "0";
  const poolUsagePct = poolSize > 0 ? (((poolSize - poolFree) / poolSize) * 100).toFixed(1) : "0";
  const poolHitRate = poolReadRequests > 0 ? (((poolReadRequests - poolReads) / poolReadRequests) * 100).toFixed(2) : "100";
  const cacheHitRate = openedTables > 0 ? ((openTables / openedTables) * 100).toFixed(1) : "100";

  return [
    { label: "Uptime", value: formatUptime(uptime) },
    { label: "Connections", value: String(threadsConnected), sub: `${connections} total` },
    { label: "QPS", value: qps, sub: `${queries.toLocaleString()} total` },
    { label: "Slow Queries", value: slowQueries.toLocaleString() },
    { label: "Threads", value: `${threadsRunning} running`, sub: `${threadsConnected} connected / ${threadsCached} cached` },
    { label: "Buffer Pool Usage", value: `${poolUsagePct}%`, sub: `Hit rate: ${poolHitRate}%` },
    { label: "Table Cache", value: `${openTables} open`, sub: `Hit rate: ${cacheHitRate}%` },
  ];
}

function ServerStatusTab({ connectionId }: { connectionId: string }) {
  const [statusVars, setStatusVars] = useState<StatusVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const results = await api.executeQuery(connectionId, "SHOW GLOBAL STATUS");
      if (results.length > 0) {
        const rows = results[0].rows.map((row) => ({
          name: String(row[0] ?? ""),
          value: String(row[1] ?? ""),
        }));
        setStatusVars(rows);
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

  const metrics = useMemo(() => computeMetrics(statusVars), [statusVars]);

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
      {error && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">{error}</div>
      )}

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
