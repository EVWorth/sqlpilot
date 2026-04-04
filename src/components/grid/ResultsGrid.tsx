import { useMemo, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type SortingState,
  type ColumnDef,
} from "@tanstack/react-table";
import { useResultStore } from "../../stores/resultStore";
import { ArrowUp, ArrowDown, Loader2, AlertCircle } from "lucide-react";

export function ResultsGrid() {
  const results = useResultStore((s) => s.results);
  const activeResultIndex = useResultStore((s) => s.activeResultIndex);
  const isExecuting = useResultStore((s) => s.isExecuting);
  const error = useResultStore((s) => s.error);
  const [sorting, setSorting] = useState<SortingState>([]);

  const activeResult = results[activeResultIndex];

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
              <tr key={row.id} className="hover:bg-[var(--color-bg-secondary)]">
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
          {activeResult.rows.length} row(s)
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {activeResult.execution_time_ms}ms
        </span>
      </div>
    </div>
  );
}
