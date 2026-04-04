import { useMemo, useState, useCallback } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type SortingState,
  type ColumnDef,
} from "@tanstack/react-table";
import { useResultStore } from "../../stores/resultStore";
import {
  ArrowUp,
  ArrowDown,
  Loader2,
  AlertCircle,
  Copy,
  FileSpreadsheet,
  FileJson,
  FileCode,
  FileText,
  ClipboardList,
  ClipboardCopy,
} from "lucide-react";
import { api } from "../../lib/tauri-api";
import type { SqlValue } from "../../types";
import { useContextMenu } from "../../hooks/useContextMenu";

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ExportToast({ message }: { message: string }) {
  return (
    <div className="animate-fade-out pointer-events-none fixed bottom-4 right-4 z-50 rounded bg-brand-600 px-3 py-1.5 text-xs text-white shadow-lg">
      {message}
    </div>
  );
}

const MIME: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  sql: "text/plain",
  markdown: "text/markdown",
};

const EXT: Record<string, string> = {
  csv: "csv",
  json: "json",
  sql: "sql",
  markdown: "md",
};

export function ResultsGrid() {
  const results = useResultStore((s) => s.results);
  const activeResultIndex = useResultStore((s) => s.activeResultIndex);
  const isExecuting = useResultStore((s) => s.isExecuting);
  const error = useResultStore((s) => s.error);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [toast, setToast] = useState<string | null>(null);
  const { contextMenu, showContextMenu } = useContextMenu();

  const activeResult = results[activeResultIndex];

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!activeResult) return;
    const header = activeResult.columns.map((c) => c.name).join("\t");
    const rows = activeResult.rows
      .map((row) => row.map((v) => (v === null ? "NULL" : String(v))).join("\t"))
      .join("\n");
    await navigator.clipboard.writeText(header + "\n" + rows);
    showToast(`Copied ${activeResult.rows.length} rows to clipboard`);
  }, [activeResult, showToast]);

  const handleExport = useCallback(
    async (format: string) => {
      if (!activeResult) return;
      try {
        const content = await api.exportResults(activeResult, format);
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        downloadBlob(
          content,
          `query-results-${ts}.${EXT[format]}`,
          MIME[format],
        );
        showToast(
          `Exported ${activeResult.rows.length} rows as ${format.toUpperCase()}`,
        );
      } catch {
        showToast(`Export failed — try Copy instead`);
      }
    },
    [activeResult, showToast],
  );

  const formatSqlValue = useCallback((val: SqlValue): string => {
    if (val === null) return "NULL";
    if (typeof val === "string") return `'${val.replace(/'/g, "''")}'`;
    if (typeof val === "boolean") return val ? "1" : "0";
    return String(val);
  }, []);

  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent<HTMLTableRowElement>, rowIdx: number) => {
      if (!activeResult) return;
      const target = e.target as HTMLElement;
      const td = target.closest("td");
      const row = activeResult.rows[rowIdx];
      const colNames = activeResult.columns.map((c) => c.name);

      // Determine which column was clicked
      let cellColIdx = 0;
      if (td) {
        const tr = td.parentElement;
        if (tr) {
          const tds = Array.from(tr.children);
          const tdIdx = tds.indexOf(td);
          cellColIdx = Math.max(0, tdIdx - 1); // -1 for row number column
        }
      }
      const cellValue = row[cellColIdx];

      const rowTsv = row
        .map((v) => (v === null ? "NULL" : String(v)))
        .join("\t");

      const insertCols = colNames.map((n) => `\`${n}\``).join(", ");
      const insertVals = row.map((v) => formatSqlValue(v)).join(", ");
      const insertStmt = `INSERT INTO your_table (${insertCols}) VALUES (${insertVals});`;

      const allRowsTsv = [
        colNames.join("\t"),
        ...activeResult.rows.map((r) =>
          r.map((v) => (v === null ? "NULL" : String(v))).join("\t"),
        ),
      ].join("\n");

      showContextMenu(e, [
        {
          label: "Copy Cell",
          icon: <Copy className="h-3.5 w-3.5" />,
          onClick: () => {
            navigator.clipboard.writeText(
              cellValue === null ? "NULL" : String(cellValue),
            );
          },
        },
        {
          label: "Copy Row (Tab-separated)",
          icon: <ClipboardList className="h-3.5 w-3.5" />,
          onClick: () => {
            navigator.clipboard.writeText(rowTsv);
          },
        },
        {
          label: "Copy as INSERT",
          icon: <FileCode className="h-3.5 w-3.5" />,
          onClick: () => {
            navigator.clipboard.writeText(insertStmt);
          },
        },
        { label: "", separator: true, onClick: () => {} },
        {
          label: "Copy All Results",
          icon: <ClipboardCopy className="h-3.5 w-3.5" />,
          onClick: () => {
            navigator.clipboard.writeText(allRowsTsv);
          },
        },
      ]);
    },
    [activeResult, showContextMenu, formatSqlValue],
  );

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    if (!activeResult) return [];
    return activeResult.columns.map((col) => ({
      id: col.name,
      accessorKey: col.name,
      header: col.name,
      cell: ({ getValue }) => {
        const val = getValue();
        if (val === null || val === undefined) {
          return (
            <span className="italic text-[var(--color-text-muted)]">NULL</span>
          );
        }
        return <span>{String(val)}</span>;
      },
      size: Math.max(100, Math.min(300, col.name.length * 10 + 40)),
    }));
  }, [activeResult]);

  const data = useMemo(() => {
    if (!activeResult) return [];
    return activeResult.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      activeResult.columns.forEach((col, idx) => {
        obj[col.name] = row[idx];
      });
      return obj;
    });
  }, [activeResult]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (isExecuting) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Executing query...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-4">
        <div className="max-w-lg rounded border border-red-800 bg-red-900/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-red-400">
            <AlertCircle className="h-4 w-4" />
            Query Error
          </div>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-red-300">
            {error}
          </pre>
        </div>
      </div>
    );
  }

  if (!activeResult || activeResult.columns.length === 0) {
    if (activeResult && activeResult.rows_affected >= 0) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
          Query executed. {activeResult.rows_affected} row(s) affected. (
          {activeResult.execution_time_ms}ms)
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        Execute a query to see results
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Result set tabs */}
      {results.length > 1 && (
        <div className="flex border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          {results.map((_, idx) => (
            <button
              key={idx}
              onClick={() => useResultStore.getState().setActiveResult(idx)}
              className={`px-3 py-1 text-xs ${idx === activeResultIndex ? "border-b-2 border-brand-500 text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)]"}`}
            >
              Result {idx + 1}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                <th className="w-12 border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-center font-normal text-[var(--color-text-muted)]">
                  #
                </th>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="cursor-pointer select-none border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-left font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                    style={{ width: header.getSize() }}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                      {header.column.getIsSorted() === "asc" && (
                        <ArrowUp className="h-3 w-3" />
                      )}
                      {header.column.getIsSorted() === "desc" && (
                        <ArrowDown className="h-3 w-3" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, rowIdx) => (
              <tr
                key={row.id}
                className="hover:bg-[var(--color-bg-secondary)]"
                onContextMenu={(e) => handleRowContextMenu(e, rowIdx)}
              >
                <td className="border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-[var(--color-text-muted)]">
                  {rowIdx + 1}
                </td>
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="border-b border-r border-[var(--color-border)] px-2 py-1 text-[var(--color-text-primary)]"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {activeResult.rows.length} row(s) &middot; {activeResult.execution_time_ms}ms
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            title="Copy as tab-separated values"
          >
            <Copy className="h-3 w-3" /> Copy
          </button>
          <button
            onClick={() => handleExport("csv")}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            title="Download CSV"
          >
            <FileSpreadsheet className="h-3 w-3" /> CSV
          </button>
          <button
            onClick={() => handleExport("json")}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            title="Download JSON"
          >
            <FileJson className="h-3 w-3" /> JSON
          </button>
          <button
            onClick={() => handleExport("sql")}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            title="Download SQL"
          >
            <FileCode className="h-3 w-3" /> SQL
          </button>
          <button
            onClick={() => handleExport("markdown")}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            title="Download Markdown"
          >
            <FileText className="h-3 w-3" /> MD
          </button>
        </div>
      </div>

      {toast && <ExportToast message={toast} />}
      {contextMenu}
    </div>
  );
}
