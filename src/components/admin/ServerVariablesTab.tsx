import { ArrowUpDown, Check, ChevronDown, ChevronRight, Copy, Loader2, Pencil, Search } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { serverFlavour } from "../../lib/server-flavour";
import { cn } from "../../lib/utils";
import { useAdminStore, variablesOf } from "../../stores/adminStore";
import { useConnectionStore } from "../../stores/connectionStore";
import type { ServerVariable } from "../../types";
import { SetVariableDialog } from "./SetVariableDialog";

type SortField = "name" | "value";
type SortDir = "asc" | "desc";

export function ServerVariablesTab({ connectionId }: { connectionId: string }) {
  // The variables, their loading and their error are the store's, keyed by
  // this tab (#862).
  const view = useId();
  const { variables, loading, error } = useAdminStore((s) => variablesOf(s, view));
  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  /** The variable being edited, or null. */
  const [editing, setEditing] = useState<ServerVariable | null>(null);
  const flavour = serverFlavour(
    useConnectionStore((c) => c.activeConnections).find((c) => c.id === connectionId)
      ?.server_version,
  );

  const [reloadToken, setReloadToken] = useState(0);
  /** The variable just changed through the dialog, highlighted for a moment. */
  const [updatedName, setUpdatedName] = useState<string | null>(null);

  useEffect(() => () => useAdminStore.getState().release(view), [view]);

  useEffect(() => {
    // Only the first load (and a connection switch) shows the full-pane
    // spinner. A reload after SET refreshes in the background so the table
    // and its scroll position stay put (#819).
    void useAdminStore.getState().loadVariables(view, connectionId, { background: reloadToken !== 0 });
  }, [view, connectionId, reloadToken]);

  useEffect(() => {
    if (!updatedName) return;
    const t = setTimeout(() => setUpdatedName(null), 2000);
    return () => clearTimeout(t);
  }, [updatedName]);

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

  const { groups: grouped, matchCount } = useMemo(() => {
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

    return {
      groups: Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)),
      matchCount: filtered.length,
    };
  }, [variables, filter, sortField, sortDir]);

  if (loading && variables.length === 0) {
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
        <span className="text-xs text-[var(--color-text-muted)]" aria-live="polite">
          {filter ? `${matchCount} of ${variables.length} variables` : `${variables.length} variables`}
        </span>
      </div>

      {error && (
        <div className="border-b edge-error surface-error px-3 py-1.5 text-xs text-[var(--color-error)]">{error}</div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="sticky top-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-secondary)]">
              <SortHeader
                label="Variable Name"
                field="name"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleSort}
              />
              <SortHeader label="Value" field="value" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
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
                onEdit={setEditing}
                updatedName={updatedName}
              />
            ))}
            {grouped.length === 0 && variables.length > 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
                  No variables match “{filter}”
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <SetVariableDialog
        variable={editing}
        connectionId={connectionId}
        flavour={flavour}
        onClose={() => setEditing(null)}
        onChanged={(name) => {
          setUpdatedName(name);
          setReloadToken((t) => t + 1);
        }}
      />
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
  onEdit,
  updatedName,
}: {
  group: string;
  variables: ServerVariable[];
  collapsed: boolean;
  onToggle: () => void;
  onCopy: (text: string, key: string) => void;
  copiedKey: string | null;
  onEdit: (v: ServerVariable) => void;
  updatedName: string | null;
}) {
  return (
    <>
      <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-secondary)]">
        <td colSpan={2} className="p-0">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-[var(--color-text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
          >
            {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {group}
            <span className="text-[var(--color-text-muted)]">({variables.length})</span>
          </button>
        </td>
      </tr>
      {!collapsed
        && variables.map((v) => (
          <tr
            key={v.name}
            data-updated={updatedName === v.name ? "true" : undefined}
            className={cn(
              "border-b border-[var(--color-border)] text-[var(--color-text-primary)] transition-colors duration-700 hover:bg-[var(--color-bg-secondary)]",
              updatedName === v.name && "bg-brand-500/15",
            )}
          >
            <td className="px-3 py-1.5">
              <button
                onClick={() => onCopy(v.name, `name:${v.name}`)}
                className="group flex items-center gap-1 font-mono hover:text-brand-400"
                title="Copy variable name"
              >
                {v.name}
                {copiedKey === `name:${v.name}`
                  ? <Check className="h-3 w-3 text-[var(--color-success)]" />
                  : <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />}
              </button>
            </td>
            <td className="px-3 py-1.5">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onCopy(v.value, `value:${v.name}`)}
                  className="group flex items-center gap-1 font-mono text-[var(--color-text-secondary)] hover:text-brand-400"
                  title="Copy value"
                >
                  <span className="max-w-[520px] truncate">{v.value}</span>
                  {copiedKey === `value:${v.name}`
                    ? <Check className="h-3 w-3 text-[var(--color-success)]" />
                    : <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />}
                </button>
                <button
                  onClick={() => onEdit(v)}
                  disabled={v.readOnly === true}
                  title={v.readOnly === true
                    ? "The server reports this variable as read-only"
                    : `Change ${v.name}`}
                  className="ml-auto shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:opacity-100 disabled:cursor-not-allowed [tr:hover_&]:opacity-100"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
              {v.description && (
                <p className="mt-0.5 max-w-[600px] text-[10px] leading-tight text-[var(--color-text-muted)]">
                  {v.description}
                </p>
              )}
            </td>
          </tr>
        ))}
    </>
  );
}

function SortHeader({
  label,
  field,
  sortField,
  sortDir,
  onSort,
}: {
  label: string;
  field: SortField;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}) {
  const active = sortField === field;
  return (
    <th
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      className="px-3 py-2"
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className="flex items-center gap-1 rounded select-none hover:text-[var(--color-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        {label}
        <ArrowUpDown className={cn("h-3 w-3", active && "text-[var(--color-text-primary)]")} />
      </button>
    </th>
  );
}
