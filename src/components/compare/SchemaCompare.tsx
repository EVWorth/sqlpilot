import { AlertTriangle, ArrowLeftRight, ChevronDown, ChevronRight, Loader2, Play, X } from "lucide-react";
import { useCallback, useState } from "react";
import { compareSchemas } from "../../lib/schema-diff";
import type { ColumnModification, SchemaComparison, SchemaSnapshot, TableDiff } from "../../lib/schema-diff";
import { generateSyncSQL } from "../../lib/sync-sql-generator";
import type { SyncStatement } from "../../lib/sync-sql-generator";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connectionStore";
import type { ColumnInfo, DatabaseInfo, RoutineInfo } from "../../types";
import { SyncPreview } from "./SyncPreview";

interface EndpointState {
  connectionId: string;
  database: string;
  databases: DatabaseInfo[];
}

type Side = "source" | "target";

type RoutineIssue =
  | { kind: "routines-mariadb-upgrade"; side: Side; raw: string }
  | { kind: "routines-failed"; side: Side; raw: string };

function classifyRoutinesError(raw: string, side: Side): RoutineIssue {
  if (/1558|mysql\.proc|mariadb-upgrade/i.test(raw)) {
    return { kind: "routines-mariadb-upgrade", side, raw };
  }
  return { kind: "routines-failed", side, raw };
}

export function SchemaCompare() {
  const activeConnections = useConnectionStore((s) => s.activeConnections);

  const [source, setSource] = useState<EndpointState>({ connectionId: "", database: "", databases: [] });
  const [target, setTarget] = useState<EndpointState>({ connectionId: "", database: "", databases: [] });
  const [includeRoutines, setIncludeRoutines] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routineIssues, setRoutineIssues] = useState<RoutineIssue[]>([]);
  const [comparison, setComparison] = useState<SchemaComparison | null>(null);
  const [syncStatements, setSyncStatements] = useState<SyncStatement[]>([]);
  const [showSync, setShowSync] = useState(false);

  const loadDatabases = useCallback(async (connectionId: string, setter: (s: EndpointState) => void) => {
    if (!connectionId) {
      setter({ connectionId: "", database: "", databases: [] });
      return;
    }
    try {
      const databases = await api.getDatabases(connectionId);
      setter({ connectionId, database: "", databases });
    } catch (e) {
      setError(`Failed to load databases: ${e}`);
    }
  }, []);

  const fetchSnapshot = useCallback(async (
    connectionId: string,
    database: string,
    options: { includeRoutines: boolean },
  ): Promise<{ snapshot: SchemaSnapshot; routinesError: string | null }> => {
    const [tables, views, triggers] = await Promise.all([
      api.getTables(connectionId, database),
      api.getViews(connectionId, database),
      api.getTriggers(connectionId, database),
    ]);

    let routines: RoutineInfo[] = [];
    let routinesError: string | null = null;
    if (options.includeRoutines) {
      try {
        routines = await api.getRoutines(connectionId, database);
      } catch (e) {
        routinesError = String(e);
      }
    }

    const baseTables = tables.filter((t) => t.table_type === "BASE TABLE" || t.table_type === "TABLE");

    const tableDetails = await Promise.all(
      baseTables.map(async (t) => {
        const [columns, indexes] = await Promise.all([
          api.getColumns(connectionId, database, t.name),
          api.getIndexes(connectionId, database, t.name),
        ]);
        return { name: t.name, columns, indexes };
      }),
    );

    const viewDetails = await Promise.all(
      views.map(async (v) => {
        try {
          const ddl = await api.getViewDdl(connectionId, database, v.name);
          return { info: v, ddl };
        } catch {
          return { info: v, ddl: "" };
        }
      }),
    );

    const routineDetails = (routinesError || !options.includeRoutines)
      ? []
      : await Promise.all(
        routines.map(async (r) => {
          try {
            const ddl = await api.getRoutineDdl(connectionId, database, r.name, r.routine_type);
            return { info: r, ddl };
          } catch {
            return { info: r, ddl: "" };
          }
        }),
      );

    const triggerDetails = await Promise.all(
      triggers.map(async (t) => {
        try {
          const ddl = await api.getTriggerDdl(connectionId, database, t.name);
          return { info: t, ddl };
        } catch {
          return { info: t, ddl: "" };
        }
      }),
    );

    return {
      snapshot: {
        tables: tableDetails,
        views: viewDetails,
        routines: routineDetails,
        triggers: triggerDetails,
      },
      routinesError,
    };
  }, []);

  const handleCompare = useCallback(async () => {
    if (!source.connectionId || !source.database || !target.connectionId || !target.database) return;
    setComparing(true);
    setError(null);
    setRoutineIssues([]);
    setComparison(null);
    setSyncStatements([]);
    setShowSync(false);

    try {
      const [
        { snapshot: srcSnapshot, routinesError: srcRoutinesError },
        { snapshot: tgtSnapshot, routinesError: tgtRoutinesError },
      ] = await Promise.all([
        fetchSnapshot(source.connectionId, source.database, { includeRoutines }),
        fetchSnapshot(target.connectionId, target.database, { includeRoutines }),
      ]);

      const issues: RoutineIssue[] = [];
      if (srcRoutinesError) issues.push(classifyRoutinesError(srcRoutinesError, "source"));
      if (tgtRoutinesError) issues.push(classifyRoutinesError(tgtRoutinesError, "target"));
      setRoutineIssues(issues);

      const result = compareSchemas(srcSnapshot, tgtSnapshot);
      setComparison(result);

      const stmts = generateSyncSQL(result, srcSnapshot);
      setSyncStatements(stmts);
    } catch (e) {
      setError(`Comparison failed: ${e}`);
    } finally {
      setComparing(false);
    }
  }, [source, target, includeRoutines, fetchSnapshot]);

  const canCompare = source.connectionId && source.database && target.connectionId && target.database && !comparing;

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      {/* Setup Section */}
      <div className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
        <div className="flex items-center gap-4">
          <EndpointSelector
            label="Source"
            connections={activeConnections}
            state={source}
            onConnectionChange={(id) => loadDatabases(id, (s) => setSource(s))}
            onDatabaseChange={(db) => setSource((prev) => ({ ...prev, database: db }))}
          />
          <ArrowLeftRight className="mt-5 h-5 w-5 shrink-0 text-[var(--color-text-muted)]" />
          <EndpointSelector
            label="Target"
            connections={activeConnections}
            state={target}
            onConnectionChange={(id) => loadDatabases(id, (s) => setTarget(s))}
            onDatabaseChange={(db) => setTarget((prev) => ({ ...prev, database: db }))}
          />
          <div className="mt-5 flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={includeRoutines}
                onChange={(e) => setIncludeRoutines(e.target.checked)}
                className="h-3 w-3 cursor-pointer rounded border-[var(--color-border)] accent-brand-500"
                aria-label="Include routines in comparison"
              />
              Include routines
            </label>
            <button
              onClick={handleCompare}
              disabled={!canCompare}
              className="flex items-center gap-2 rounded bg-brand-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-brand-600"
            >
              {comparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Compare
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-2 flex items-center gap-2 rounded bg-red-500/10 px-3 py-1.5 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </div>
        )}
        {routineIssues.length > 0 && (
          <div className="mt-2 space-y-2">
            {routineIssues.map((issue, idx) => (
              <RoutineIssueBanner
                key={`${issue.kind}-${issue.side}-${idx}`}
                issue={issue}
                onDismiss={() => setRoutineIssues((prev) => prev.filter((_, i) => i !== idx))}
              />
            ))}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto p-4">
        {comparing && (
          <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-muted)]">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Comparing schemas...
          </div>
        )}

        {comparison && !showSync && (
          <ComparisonResults
            comparison={comparison}
            onShowSync={() => setShowSync(true)}
            hasSyncStatements={syncStatements.length > 0}
          />
        )}

        {showSync && comparison && (
          <SyncPreview
            statements={syncStatements}
            targetConnectionId={target.connectionId}
            targetDatabase={target.database}
            onBack={() => setShowSync(false)}
          />
        )}

        {!comparison && !comparing && (
          <div className="flex flex-col items-center justify-center py-16 text-[var(--color-text-muted)]">
            <ArrowLeftRight className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">Select source and target databases, then click Compare</p>
          </div>
        )}
      </div>
    </div>
  );
}

function EndpointSelector({
  label,
  connections,
  state,
  onConnectionChange,
  onDatabaseChange,
}: {
  label: string;
  connections: { id: string; name: string }[];
  state: EndpointState;
  onConnectionChange: (id: string) => void;
  onDatabaseChange: (db: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[var(--color-text-secondary)]">{label}</span>
      <div className="flex gap-2">
        <select
          value={state.connectionId}
          onChange={(e) => onConnectionChange(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500"
        >
          <option value="">Select connection...</option>
          {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={state.database}
          onChange={(e) => onDatabaseChange(e.target.value)}
          disabled={state.databases.length === 0}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500 disabled:cursor-not-allowed disabled:text-[var(--color-text-muted)] disabled:opacity-70"
        >
          <option value="">Select database...</option>
          {state.databases.map((db) => <option key={db.name} value={db.name}>{db.name}</option>)}
        </select>
      </div>
    </div>
  );
}

function RoutineIssueBanner({
  issue,
  onDismiss,
}: {
  issue: RoutineIssue;
  onDismiss: () => void;
}) {
  const heading = issue.kind === "routines-mariadb-upgrade"
    ? `Routines skipped — MariaDB upgrade needed on ${issue.side}`
    : `Could not fetch routines from ${issue.side}`;

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="flex-1 space-y-1">
        <div className="font-medium">{heading}</div>
        {issue.kind === "routines-mariadb-upgrade"
          ? (
            <>
              <div>
                The server's <code className="rounded bg-black/30 px-1 font-mono">mysql.proc</code>{" "}
                system table is out of date. Tables, views, and triggers were compared normally; routines were skipped.
              </div>
              <div>
                Run on the server and retry:
              </div>
              <pre className="overflow-x-auto rounded bg-black/30 px-2 py-1 font-mono text-[11px]">
                mariadb-upgrade -u root -p
              </pre>
            </>
          )
          : (
            <pre className="overflow-x-auto rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-yellow-300/80">
              {issue.raw.length > 200 ? issue.raw.slice(0, 200) + "…" : issue.raw}
            </pre>
          )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-yellow-300/70 hover:bg-yellow-500/20 hover:text-yellow-200"
        aria-label="Dismiss warning"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ComparisonResults({
  comparison,
  onShowSync,
  hasSyncStatements,
}: {
  comparison: SchemaComparison;
  onShowSync: () => void;
  hasSyncStatements: boolean;
}) {
  const t = comparison.tables;
  const totalTables = t.onlyInSource.length + t.onlyInTarget.length + t.different.length + t.identical.length;
  const totalChanges = t.onlyInSource.length + t.onlyInTarget.length + t.different.length;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-2">
        <div className="flex gap-4 text-xs">
          <span className="text-green-400">{t.onlyInSource.length} only in source</span>
          <span className="text-red-400">{t.onlyInTarget.length} only in target</span>
          <span className="text-yellow-400">{t.different.length} different</span>
          <span className="text-[var(--color-text-muted)]">{t.identical.length} identical</span>
          <span className="text-[var(--color-text-secondary)]">{totalTables} total tables</span>
        </div>
        {hasSyncStatements && (
          <button
            onClick={onShowSync}
            className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-500"
          >
            Generate Sync SQL
          </button>
        )}
      </div>

      {/* Tables Section */}
      {totalChanges > 0 && (
        <DiffSection title="Tables">
          {t.onlyInSource.map((name) => <DiffItem key={`src-${name}`} name={name} status="source-only" />)}
          {t.onlyInTarget.map((name) => <DiffItem key={`tgt-${name}`} name={name} status="target-only" />)}
          {t.different.map((diff) => <DiffTableItem key={`diff-${diff.name}`} diff={diff} />)}
        </DiffSection>
      )}

      {/* Identical tables */}
      {t.identical.length > 0 && (
        <CollapsibleSection title={`Identical Tables (${t.identical.length})`} defaultOpen={false}>
          {t.identical.map((name) => <DiffItem key={`id-${name}`} name={name} status="identical" />)}
        </CollapsibleSection>
      )}

      {/* Views */}
      <ObjectDiffSection title="Views" diff={comparison.views} />
      {/* Routines */}
      <ObjectDiffSection title="Routines" diff={comparison.routines} />
      {/* Triggers */}
      <ObjectDiffSection title="Triggers" diff={comparison.triggers} />
    </div>
  );
}

function DiffSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-[var(--color-border)]">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)]">
        {title}
      </div>
      <div className="divide-y divide-[var(--color-border)]">{children}</div>
    </div>
  );
}

function DiffItem({ name, status }: { name: string; status: "source-only" | "target-only" | "identical" }) {
  const colorMap = {
    "source-only": "text-green-400",
    "target-only": "text-red-400",
    identical: "text-[var(--color-text-muted)]",
  };
  const labelMap = {
    "source-only": "CREATE",
    "target-only": "DROP",
    identical: "OK",
  };
  const bgMap = {
    "source-only": "bg-green-500/10",
    "target-only": "bg-red-500/10",
    identical: "",
  };

  return (
    <div className={cn("flex items-center justify-between px-3 py-1.5 text-xs", bgMap[status])}>
      <span className="text-[var(--color-text-primary)]">{name}</span>
      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", colorMap[status])}>
        {labelMap[status]}
      </span>
    </div>
  );
}

function DiffTableItem({ diff }: { diff: TableDiff }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-yellow-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-yellow-500/10"
      >
        <div className="flex items-center gap-1.5">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="text-[var(--color-text-primary)]">{diff.name}</span>
        </div>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">ALTERED</span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--color-border)] px-4 py-2">
          {/* Column diffs */}
          {diff.columns.added.length > 0 && (
            <div className="mb-2">
              <h4 className="mb-1 text-[10px] font-semibold uppercase text-green-400">Added Columns</h4>
              {diff.columns.added.map((col) => <ColumnRow key={col.name} col={col} variant="added" />)}
            </div>
          )}
          {diff.columns.removed.length > 0 && (
            <div className="mb-2">
              <h4 className="mb-1 text-[10px] font-semibold uppercase text-red-400">Removed Columns</h4>
              {diff.columns.removed.map((col) => <ColumnRow key={col.name} col={col} variant="removed" />)}
            </div>
          )}
          {diff.columns.modified.length > 0 && (
            <div className="mb-2">
              <h4 className="mb-1 text-[10px] font-semibold uppercase text-yellow-400">Modified Columns</h4>
              {diff.columns.modified.map((mod) => <ModifiedColumnRow key={mod.name} mod={mod} />)}
            </div>
          )}
          {/* Index diffs */}
          {(diff.indexes.added.length > 0 || diff.indexes.removed.length > 0) && (
            <div>
              <h4 className="mb-1 text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">Index Changes</h4>
              {diff.indexes.added.map((idx) => (
                <div key={`add-${idx.name}`} className="flex items-center gap-2 py-0.5 text-[11px]">
                  <span className="text-green-400">+ {idx.name}</span>
                  <span className="text-[var(--color-text-muted)]">({idx.columns.join(", ")})</span>
                </div>
              ))}
              {diff.indexes.removed.map((idx) => (
                <div key={`rm-${idx.name}`} className="flex items-center gap-2 py-0.5 text-[11px]">
                  <span className="text-red-400">- {idx.name}</span>
                  <span className="text-[var(--color-text-muted)]">({idx.columns.join(", ")})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ColumnRow({ col, variant }: { col: ColumnInfo; variant: "added" | "removed" }) {
  const color = variant === "added" ? "text-green-400" : "text-red-400";
  const prefix = variant === "added" ? "+" : "-";
  return (
    <div className={cn("flex items-center gap-3 py-0.5 text-[11px]", color)}>
      <span className="w-3">{prefix}</span>
      <span className="w-32 font-medium">{col.name}</span>
      <span className="text-[var(--color-text-muted)]">{col.column_type}</span>
      <span className="text-[var(--color-text-muted)]">{col.nullable ? "NULL" : "NOT NULL"}</span>
    </div>
  );
}

function ModifiedColumnRow({ mod }: { mod: ColumnModification }) {
  return (
    <div className="py-1">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="w-3 text-yellow-400">~</span>
        <span className="w-32 font-medium text-yellow-400">{mod.name}</span>
      </div>
      <div className="ml-5 mt-0.5 space-y-0.5">
        {mod.changes.map((change) => (
          <div key={change} className="text-[10px] text-[var(--color-text-muted)]">
            {change}
          </div>
        ))}
      </div>
    </div>
  );
}

function ObjectDiffSection<T extends { name: string }>({
  title,
  diff,
}: {
  title: string;
  diff: { onlyInSource: T[]; onlyInTarget: T[]; different: string[]; identical: string[] };
}) {
  const totalChanges = diff.onlyInSource.length + diff.onlyInTarget.length + diff.different.length;
  if (totalChanges === 0 && diff.identical.length === 0) return null;

  return (
    <div>
      {totalChanges > 0 && (
        <DiffSection title={title}>
          {diff.onlyInSource.map((item) => <DiffItem key={`src-${item.name}`} name={item.name} status="source-only" />)}
          {diff.onlyInTarget.map((item) => <DiffItem key={`tgt-${item.name}`} name={item.name} status="target-only" />)}
          {diff.different.map((name) => (
            <div key={`diff-${name}`} className="flex items-center justify-between bg-yellow-500/5 px-3 py-1.5 text-xs">
              <span className="text-[var(--color-text-primary)]">{name}</span>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">DIFFERENT</span>
            </div>
          ))}
        </DiffSection>
      )}
      {diff.identical.length > 0 && (
        <CollapsibleSection title={`Identical ${title} (${diff.identical.length})`} defaultOpen={false}>
          {diff.identical.map((name) => <DiffItem key={`id-${name}`} name={name} status="identical" />)}
        </CollapsibleSection>
      )}
    </div>
  );
}

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded border border-[var(--color-border)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open && <div className="divide-y divide-[var(--color-border)]">{children}</div>}
    </div>
  );
}
