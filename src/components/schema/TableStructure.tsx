import Editor from "@monaco-editor/react";
import { Code2, Columns3, Key, ListTree, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/tauri-api";
import { cn } from "../../lib/utils";
import type { ColumnInfo, IndexInfo } from "../../types";

type SubTab = "columns" | "indexes" | "ddl";

interface TableStructureProps {
  connectionId: string;
  database: string;
  tableName: string;
}

export function TableStructure({
  connectionId,
  database,
  tableName,
}: TableStructureProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>("columns");
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [ddl, setDdl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.getColumns(connectionId, database, tableName),
      api.getIndexes(connectionId, database, tableName),
      api.getTableDdl(connectionId, database, tableName),
    ])
      .then(([cols, idxs, ddlText]) => {
        setColumns(cols);
        setIndexes(idxs);
        setDdl(ddlText);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [connectionId, database, tableName]);

  const subTabs: { key: SubTab; label: string; icon: typeof Columns3 }[] = [
    { key: "columns", label: "Columns", icon: Columns3 },
    { key: "indexes", label: "Indexes", icon: ListTree },
    { key: "ddl", label: "DDL", icon: Code2 },
  ];

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="flex h-8 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          {database}.{tableName}
        </span>
      </div>

      {/* Sub-tabs */}
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

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading
          ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--color-text-muted)]" />
              <span className="ml-2 text-sm text-[var(--color-text-muted)]">
                Loading structure…
              </span>
            </div>
          )
          : error
          ? (
            <div className="flex h-full items-center justify-center">
              <span className="text-sm text-red-400">{error}</span>
            </div>
          )
          : (
            <>
              {activeSubTab === "columns" && <ColumnsTable columns={columns} />}
              {activeSubTab === "indexes" && <IndexesTable indexes={indexes} />}
              {activeSubTab === "ddl" && <DdlView ddl={ddl} />}
            </>
          )}
      </div>
    </div>
  );
}

function ColumnsTable({ columns }: { columns: ColumnInfo[] }) {
  if (columns.length === 0) {
    return (
      <div className="p-4 text-sm text-[var(--color-text-muted)]">
        No columns found.
      </div>
    );
  }

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-secondary)]">
          <th className="w-8 px-3 py-2 text-center">#</th>
          <th className="px-3 py-2">Name</th>
          <th className="px-3 py-2">Type</th>
          <th className="w-16 px-3 py-2 text-center">Nullable</th>
          <th className="px-3 py-2">Default</th>
          <th className="w-10 px-3 py-2 text-center">PK</th>
          <th className="px-3 py-2">Extra</th>
          <th className="px-3 py-2">Comment</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((col, i) => (
          <tr
            key={col.name}
            className="border-b border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
          >
            <td className="px-3 py-1.5 text-center text-[var(--color-text-muted)]">
              {i + 1}
            </td>
            <td className="px-3 py-1.5 font-medium">
              {col.name}
            </td>
            <td className="px-3 py-1.5 font-mono text-[var(--color-text-secondary)]">
              {col.column_type}
            </td>
            <td className="px-3 py-1.5 text-center">
              {col.nullable ? <span className="text-green-400">✓</span> : <span className="text-red-400">✗</span>}
            </td>
            <td className="px-3 py-1.5 font-mono text-[var(--color-text-muted)]">
              {col.default_value ?? <span className="italic opacity-50">NULL</span>}
            </td>
            <td className="px-3 py-1.5 text-center">
              {col.is_primary_key && <Key className="mx-auto h-3.5 w-3.5 text-yellow-400" />}
            </td>
            <td className="px-3 py-1.5 text-[var(--color-text-muted)]">
              {col.extra}
            </td>
            <td className="max-w-[200px] truncate px-3 py-1.5 text-[var(--color-text-muted)]">
              {col.comment}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IndexesTable({ indexes }: { indexes: IndexInfo[] }) {
  if (indexes.length === 0) {
    return (
      <div className="p-4 text-sm text-[var(--color-text-muted)]">
        No indexes found.
      </div>
    );
  }

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-secondary)]">
          <th className="px-3 py-2">Name</th>
          <th className="px-3 py-2">Columns</th>
          <th className="w-20 px-3 py-2 text-center">Unique</th>
          <th className="px-3 py-2">Type</th>
        </tr>
      </thead>
      <tbody>
        {indexes.map((idx) => (
          <tr
            key={idx.name}
            className="border-b border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
          >
            <td className="px-3 py-1.5 font-medium">{idx.name}</td>
            <td className="px-3 py-1.5 font-mono text-[var(--color-text-secondary)]">
              {idx.columns.join(", ")}
            </td>
            <td className="px-3 py-1.5 text-center">
              {idx.is_unique && (
                <span className="inline-block rounded bg-brand-600/20 px-1.5 py-0.5 text-[10px] font-medium text-brand-400">
                  UNIQUE
                </span>
              )}
            </td>
            <td className="px-3 py-1.5 text-[var(--color-text-muted)]">
              {idx.index_type}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DdlView({ ddl }: { ddl: string }) {
  return (
    <Editor
      height="100%"
      language="sql"
      theme="vs-dark"
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
