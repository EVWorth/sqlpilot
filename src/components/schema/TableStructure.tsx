import Editor from "@monaco-editor/react";
import { Code2, Columns3, Info, Key, Link2, ListTree, Loader2, Rows3, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import { useSchemaStore } from "../../stores/schemaStore";
import { useThemeStore } from "../../stores/themeStore";
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, PartitionInfo, TableInfo, TriggerInfo } from "../../types";

/**
 * Everything FR-4.2.1 asks for about a table.
 *
 * Three of the eight were here — Columns, Indexes, DDL — and the rest had
 * nowhere to appear, including the foreign keys the backend was already able
 * to answer for (#292).
 *
 * Overview leads, because "how big is this and what is it" is the question
 * someone opening a table has before any of the details.
 */

type SubTab = "overview" | "columns" | "indexes" | "foreignKeys" | "triggers" | "partitions" | "ddl";

interface TableStructureProps {
  connectionId: string;
  database: string;
  tableName: string;
}

interface Details {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  triggers: TriggerInfo[];
  partitions: PartitionInfo[];
  table?: TableInfo;
  ddl: string;
}

const EMPTY: Details = {
  columns: [],
  indexes: [],
  foreignKeys: [],
  triggers: [],
  partitions: [],
  ddl: "",
};

export function TableStructure({
  connectionId,
  database,
  tableName,
}: TableStructureProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>("overview");
  const [details, setDetails] = useState<Details>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    let cancelled = false;

    void (async () => {
      try {
        const [columns, indexes, foreignKeys, partitions, ddl, triggers, tables] = await Promise
          .all([
            api.getColumns(connectionId, database, tableName),
            api.getIndexes(connectionId, database, tableName),
            api.getForeignKeys(connectionId, database, tableName),
            api.getPartitions(connectionId, database, tableName),
            api.getTableDdl(connectionId, database, tableName),
            // Through the store: the tree has usually loaded both already, and
            // the server has no per-table trigger query to ask instead.
            useSchemaStore.getState().ensureTriggers(connectionId, database),
            useSchemaStore.getState().ensureTables(connectionId, database),
          ]);
        if (cancelled) return;
        setDetails({
          columns,
          indexes,
          foreignKeys,
          partitions,
          ddl,
          triggers: triggers.filter((t) => t.table === tableName),
          table: tables.find((t) => t.name === tableName),
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionId, database, tableName]);

  // Tabs with nothing in them are still shown: "this table has no foreign
  // keys" is an answer, and a tab that appears only sometimes makes the panel
  // look different for every table.
  const subTabs: { key: SubTab; label: string; icon: typeof Columns3; count?: number }[] = [
    { key: "overview", label: "Overview", icon: Info },
    { key: "columns", label: "Columns", icon: Columns3, count: details.columns.length },
    { key: "indexes", label: "Indexes", icon: ListTree, count: details.indexes.length },
    { key: "foreignKeys", label: "Foreign Keys", icon: Link2, count: details.foreignKeys.length },
    { key: "triggers", label: "Triggers", icon: Zap, count: details.triggers.length },
    { key: "partitions", label: "Partitions", icon: Rows3, count: details.partitions.length },
    { key: "ddl", label: "DDL", icon: Code2 },
  ];

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      <div className="flex h-8 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          {database}.{tableName}
        </span>
      </div>

      <div className="flex shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        {subTabs.map(({ key, label, icon: Icon, count }) => (
          <button
            key={key}
            onClick={() => setActiveSubTab(key)}
            aria-pressed={activeSubTab === key}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs transition-colors",
              activeSubTab === key
                ? "border-brand-500 text-[var(--color-text-primary)]"
                : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {count != null && count > 0 && (
              <span className="rounded bg-[var(--color-bg-tertiary)] px-1 text-[10px] tabular-nums">
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading
          ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          )
          : error
          ? <div className="p-4 text-sm text-red-400">{error}</div>
          : (
            <>
              {activeSubTab === "overview" && <Overview details={details} />}
              {activeSubTab === "columns" && <ColumnsTable columns={details.columns} />}
              {activeSubTab === "indexes" && <IndexesTable indexes={details.indexes} />}
              {activeSubTab === "foreignKeys" && <ForeignKeysTable keys={details.foreignKeys} />}
              {activeSubTab === "triggers" && <TriggersTable triggers={details.triggers} />}
              {activeSubTab === "partitions" && <PartitionsTable partitions={details.partitions} />}
              {activeSubTab === "ddl" && <DdlView ddl={details.ddl} />}
            </>
          )}
      </div>
    </div>
  );
}

function Empty({ what }: { what: string }) {
  return <div className="p-4 text-sm text-[var(--color-text-muted)]">This table has no {what}.</div>;
}

/** Bytes as someone would say them. */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return unit === 0 ? `${size} B` : `${size.toFixed(1)} ${units[unit]}`;
}

function Overview({ details }: { details: Details }) {
  const { table } = details;
  const rows: { label: string; value: React.ReactNode; note?: string }[] = [
    {
      label: "Rows",
      value: table?.row_count != null ? table.row_count.toLocaleString() : "—",
      // InnoDB samples this from the index; it can be out by a wide margin on
      // a table with churn, and presenting it as exact invites someone to
      // trust it for a count.
      note: "approximate",
    },
    { label: "Data size", value: table?.data_size != null ? formatBytes(table.data_size) : "—" },
    { label: "Engine", value: table?.engine ?? "—" },
    { label: "Type", value: table?.table_type ?? "—" },
    { label: "Columns", value: details.columns.length },
    { label: "Indexes", value: details.indexes.length },
    { label: "Foreign keys", value: details.foreignKeys.length },
    { label: "Triggers", value: details.triggers.length },
    {
      label: "Partitions",
      value: details.partitions.length === 0 ? "not partitioned" : details.partitions.length,
    },
    { label: "Comment", value: table?.comment || "—" },
  ];

  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5 p-4 text-xs">
      {rows.map(({ label, value, note }) => (
        <div key={label} className="contents">
          <dt className="text-[var(--color-text-muted)]">{label}</dt>
          <dd className="text-[var(--color-text-primary)]">
            {value}
            {note && <span className="ml-1.5 text-[var(--color-text-muted)]">({note})</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const TH = "px-3 py-2";
const TR =
  "border-b border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]";
const TD = "px-3 py-1.5";

function TableHead({ headers }: { headers: string[] }) {
  return (
    <thead>
      <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-secondary)]">
        {headers.map((h) => <th key={h} className={TH}>{h}</th>)}
      </tr>
    </thead>
  );
}

function ColumnsTable({ columns }: { columns: ColumnInfo[] }) {
  if (columns.length === 0) return <Empty what="columns" />;

  return (
    <table className="w-full text-xs">
      <TableHead
        headers={["#", "Name", "Type", "Nullable", "Default", "PK", "Extra", "Comment"]}
      />
      <tbody>
        {columns.map((col, i) => (
          <tr key={col.name} className={TR}>
            <td className={`${TD} text-center text-[var(--color-text-muted)]`}>{i + 1}</td>
            <td className={`${TD} font-medium`}>{col.name}</td>
            <td className={`${TD} font-mono text-[var(--color-text-secondary)]`}>
              {col.column_type}
            </td>
            <td className={`${TD} text-center`}>
              {col.nullable ? <span className="text-green-400">✓</span> : <span className="text-red-400">✗</span>}
            </td>
            <td className={`${TD} font-mono text-[var(--color-text-muted)]`}>
              {col.default_value ?? <span className="italic opacity-50">NULL</span>}
            </td>
            <td className={`${TD} text-center`}>
              {col.is_primary_key && <Key className="mx-auto h-3.5 w-3.5 text-yellow-400" />}
            </td>
            <td className={`${TD} text-[var(--color-text-muted)]`}>{col.extra}</td>
            <td className={`max-w-[200px] truncate ${TD} text-[var(--color-text-muted)]`}>
              {col.comment}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IndexesTable({ indexes }: { indexes: IndexInfo[] }) {
  if (indexes.length === 0) return <Empty what="indexes" />;

  return (
    <table className="w-full text-xs">
      <TableHead headers={["Name", "Columns", "Unique", "Type"]} />
      <tbody>
        {indexes.map((idx) => (
          <tr key={idx.name} className={TR}>
            <td className={`${TD} font-medium`}>{idx.name}</td>
            <td className={`${TD} font-mono text-[var(--color-text-secondary)]`}>
              {
                /* An expression index has no columns; saying so beats an empty
                  cell that reads as a rendering failure (#290). */
              }
              {idx.columns.length > 0
                ? idx.columns.join(", ")
                : <span className="italic opacity-60">expression</span>}
            </td>
            <td className={`${TD} text-center`}>
              {idx.is_unique && (
                <span className="inline-block rounded bg-brand-600/20 px-1.5 py-0.5 text-[10px] font-medium text-brand-400">
                  UNIQUE
                </span>
              )}
            </td>
            <td className={`${TD} text-[var(--color-text-muted)]`}>{idx.index_type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ForeignKeysTable({ keys }: { keys: ForeignKeyInfo[] }) {
  if (keys.length === 0) return <Empty what="foreign keys" />;

  return (
    <table className="w-full text-xs">
      <TableHead headers={["Name", "Columns", "References", "On update", "On delete"]} />
      <tbody>
        {keys.map((fk) => (
          <tr key={fk.name} className={TR}>
            <td className={`${TD} font-medium`}>{fk.name}</td>
            <td className={`${TD} font-mono text-[var(--color-text-secondary)]`}>
              {fk.columns.join(", ")}
            </td>
            <td className={`${TD} font-mono text-[var(--color-text-secondary)]`}>
              {fk.referenced_table} ({fk.referenced_columns.join(", ")})
            </td>
            {
              /* The rules are the part people come here for: whether deleting a
                parent row takes children with it is not visible anywhere
                else. */
            }
            <td className={`${TD} text-[var(--color-text-muted)]`}>{fk.on_update}</td>
            <td className={`${TD} text-[var(--color-text-muted)]`}>{fk.on_delete}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TriggersTable({ triggers }: { triggers: TriggerInfo[] }) {
  if (triggers.length === 0) return <Empty what="triggers" />;

  return (
    <table className="w-full text-xs">
      <TableHead headers={["Name", "Timing", "Event"]} />
      <tbody>
        {triggers.map((t) => (
          <tr key={t.name} className={TR}>
            <td className={`${TD} font-medium`}>{t.name}</td>
            <td className={`${TD} text-[var(--color-text-secondary)]`}>{t.timing}</td>
            <td className={`${TD} text-[var(--color-text-secondary)]`}>{t.event}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PartitionsTable({ partitions }: { partitions: PartitionInfo[] }) {
  if (partitions.length === 0) return <Empty what="partitions" />;

  return (
    <table className="w-full text-xs">
      <TableHead headers={["Name", "Method", "Expression", "Bound", "Rows", "Size"]} />
      <tbody>
        {partitions.map((p) => (
          <tr key={p.name} className={TR}>
            <td className={`${TD} font-medium`}>{p.name}</td>
            <td className={`${TD} text-[var(--color-text-secondary)]`}>{p.method}</td>
            <td className={`${TD} font-mono text-[var(--color-text-secondary)]`}>{p.expression}</td>
            <td className={`${TD} font-mono text-[var(--color-text-muted)]`}>{p.description}</td>
            <td className={`${TD} tabular-nums text-[var(--color-text-muted)]`}>
              {p.row_count.toLocaleString()}
            </td>
            <td className={`${TD} tabular-nums text-[var(--color-text-muted)]`}>
              {formatBytes(p.data_size)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DdlView({ ddl }: { ddl: string }) {
  // Follows the app's theme. It was pinned to vs-dark, so the DDL pane stayed
  // dark in a light window (#350).
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme);

  return (
    <Editor
      height="100%"
      language="sql"
      theme={effectiveTheme === "dark" ? "vs-dark" : "vs"}
      value={ddl}
      options={{
        readOnly: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        minimap: { enabled: false },
        lineNumbers: "on",
        renderLineHighlight: "none",
        scrollBeyondLastLine: false,
        wordWrap: "on",
        tabSize: 2,
        automaticLayout: true,
        padding: { top: 8, bottom: 8 },
        domReadOnly: true,
      }}
    />
  );
}
