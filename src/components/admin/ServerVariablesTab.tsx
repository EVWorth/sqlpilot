import { ArrowUpDown, Check, ChevronDown, ChevronRight, Copy, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/tauri-api";
import type { ServerVariable } from "../../types";

type SortField = "name" | "value";
type SortDir = "asc" | "desc";

export function ServerVariablesTab({ connectionId }: { connectionId: string }) {
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

      {error && <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">{error}
      </div>}

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
      {!collapsed
        && variables.map((v) => (
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
                {copiedKey === `name:${v.name}`
                  ? <Check className="h-3 w-3 text-green-400" />
                  : <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />}
              </button>
            </td>
            <td className="px-3 py-1.5">
              <button
                onClick={() => onCopy(v.value, `value:${v.name}`)}
                className="group flex items-center gap-1 font-mono text-[var(--color-text-secondary)] hover:text-brand-400"
                title="Copy value"
              >
                <span className="max-w-[600px] truncate">{v.value}</span>
                {copiedKey === `value:${v.name}`
                  ? <Check className="h-3 w-3 text-green-400" />
                  : <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />}
              </button>
            </td>
          </tr>
        ))}
    </>
  );
}
