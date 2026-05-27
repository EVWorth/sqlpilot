import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type SortingState,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useResultStore } from "../../stores/resultStore";
import {
  ArrowUp,
  ArrowDown,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Copy,
  FileSpreadsheet,
  FileJson,
  FileCode,
  FileText,
  ClipboardList,
  ClipboardCopy,
  Trash2,
  Sparkles,
} from "lucide-react";
import { api } from "../../lib/tauri-api";
import type { SqlValue } from "../../types";
import { SqlValueGuard } from "../../types";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useGridEditing } from "../../hooks/useGridEditing";
import { EditableCell } from "./EditableCell";
import { EditToolbar } from "./EditToolbar";
import {
  generateUpdate,
  generateInsert,
  generateDelete,
  extractTableName,
  getWhereColumns,
} from "../../lib/sql-generator";
import { useEditorStore } from "../../stores/editorStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useAiStore } from "../../stores/aiStore";
import { CellViewerModal } from "./CellViewerModal";
import { TruncatedCell } from "./TruncatedCell";

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
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [cellViewer, setCellViewer] = useState<{
    isOpen: boolean;
    columnName: string;
    content: string | null;
    dataType?: string;
  }>({ isOpen: false, columnName: "", content: null });
  const { contextMenu, showContextMenu } = useContextMenu();
  const editingCellRef = useRef<{ rowIndex: number; colIndex: number } | null>(
    null,
  );

  const editing = useGridEditing();
  const activeResult = results[activeResultIndex];
  const aiEnabled = useAiStore((s) => s.aiEnabled);

  const whereInfo = useMemo(() => {
    if (!activeResult) return { columns: [] as string[], hasPrimaryKey: true };
    return getWhereColumns(activeResult.columns);
  }, [activeResult]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!activeResult) return;
    const header = activeResult.columns.map((c) => c.name).join("\t");
    const rows = activeResult.rows
      .map((row) => row.map((v) => SqlValueGuard.toString(v)).join("\t"))
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

  const formatSqlVal = useCallback((val: SqlValue): string => {
    return SqlValueGuard.toSqlLiteral(val);
  }, []);

  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent<HTMLElement>, rowIdx: number) => {
      if (!activeResult) return;
      const target = e.target as HTMLElement;
      const td = target.closest("td");
      const row = activeResult.rows[rowIdx];
      const colNames = activeResult.columns.map((c) => c.name);

      let cellColIdx = 0;
      if (td) {
        const tr = td.parentElement;
        if (tr) {
          const tds = Array.from(tr.children);
          const tdIdx = tds.indexOf(td);
          cellColIdx = Math.max(0, tdIdx - 1);
        }
      }
      const cellValue = row[cellColIdx];

      const rowTsv = row
        .map((v) => SqlValueGuard.toString(v))
        .join("\t");

      const insertCols = colNames.map((n) => `\`${n}\``).join(", ");
      const insertVals = row.map((v) => formatSqlVal(v)).join(", ");
      const insertStmt = `INSERT INTO your_table (${insertCols}) VALUES (${insertVals});`;

      const allRowsTsv = [
        colNames.join("\t"),
        ...activeResult.rows.map((r) =>
          r.map((v) => SqlValueGuard.toString(v)).join("\t"),
        ),
      ].join("\n");

      const menuItems = [
        {
          label: "Copy Cell",
          icon: <Copy className="h-3.5 w-3.5" />,
          onClick: () => {
            navigator.clipboard.writeText(
              SqlValueGuard.toString(cellValue),
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
      ];

      if (editing.editMode) {
        menuItems.push(
          { label: "", separator: true, onClick: () => {} },
          {
            label: editing.isRowDeleted(rowIdx)
              ? "Unmark Delete"
              : "Delete Row",
            icon: <Trash2 className="h-3.5 w-3.5" />,
            onClick: () => editing.deleteRow(rowIdx),
          },
        );
      }

      showContextMenu(e, menuItems);
    },
    [activeResult, showContextMenu, formatSqlVal, editing],
  );

  // Build the original row record for a given row index
  const getOriginalRow = useCallback(
    (rowIdx: number): Record<string, SqlValue> => {
      if (!activeResult) return {};
      const row = activeResult.rows[rowIdx];
      const obj: Record<string, SqlValue> = {};
      activeResult.columns.forEach((col, idx) => {
        obj[col.name] = row[idx];
      });
      return obj;
    },
    [activeResult],
  );

  const handleSave = useCallback(async () => {
    if (!activeResult) return;

    const editorTab = useEditorStore.getState().tabs.find(
      (t) => t.id === useEditorStore.getState().activeTabId,
    );
    const sql = editorTab?.content ?? "";
    const tableName = extractTableName(sql);
    if (!tableName) {
      showToast("Cannot detect table name from query");
      return;
    }

    const connId =
      editorTab?.connectionId ??
      useConnectionStore.getState().selectedConnectionId;
    if (!connId) {
      showToast("No active connection");
      return;
    }

    setIsSaving(true);
    try {
      const statements: string[] = [];

      // Generate UPDATE statements
      for (const [rowIdx, changes] of editing.updates) {
        const originalRow = getOriginalRow(rowIdx);
        statements.push(
          generateUpdate(
            tableName,
            whereInfo.columns,
            originalRow,
            changes.map((c) => ({ column: c.column, newValue: c.newValue })),
          ),
        );
      }

      // Generate INSERT statements
      for (const insertRow of editing.inserts) {
        const cols = activeResult.columns.map((c) => c.name);
        statements.push(generateInsert(tableName, cols, insertRow));
      }

      // Generate DELETE statements
      for (const rowIdx of editing.deletes) {
        const originalRow = getOriginalRow(rowIdx);
        statements.push(
          generateDelete(tableName, whereInfo.columns, originalRow),
        );
      }

      // Execute all statements
      for (const stmt of statements) {
        await api.executeQuery(connId, stmt);
      }

      // Re-run original query to refresh
      editing.discardAll();
      await useResultStore.getState().executeQuery(connId, sql);
      showToast(`Applied ${statements.length} change(s)`);
    } catch (e) {
      showToast(`Save failed: ${String(e)}`);
    } finally {
      setIsSaving(false);
    }
  }, [activeResult, editing, getOriginalRow, whereInfo, showToast]);

  const maxContentLen = useMemo<Record<string, number>>(() => {
    if (!activeResult) return {};
    const lens: Record<string, number> = {};
    activeResult.columns.forEach((col) => {
      lens[col.name] = col.name.length;
    });
    activeResult.rows.forEach((row) => {
      row.forEach((val, idx) => {
        const colName = activeResult.columns[idx]?.name;
        if (!colName) return;
        const len = String(val ?? "").length;
        if (len > lens[colName]) lens[colName] = len;
      });
    });
    return lens;
  }, [activeResult]);

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    if (!activeResult) return [];

    return activeResult.columns.map((col, colIdx) => ({
      id: col.name,
      accessorKey: col.name,
      header: col.name,
      cell: ({ getValue, row }) => {
        const rowIdx = row.index;
        const originalValue = getValue() as SqlValue;

        if (!editing.editMode) {
          return (
            <TruncatedCell
              value={originalValue}
              columnName={col.name}
              onViewFull={(content, colName) => {
                setCellViewer({
                  isOpen: true,
                  columnName: colName,
                  content,
                  dataType: col.data_type,
                });
              }}
            />
          );
        }

        const currentValue = editing.getCellValue(
          rowIdx,
          col.name,
          originalValue,
        );
        const isEdited = editing.isCellEdited(rowIdx, col.name);

        return (
          <EditableCell
            value={currentValue}
            dataType={col.data_type}
            isEdited={isEdited}
            onCommit={(newValue) => {
              editing.editCell(rowIdx, col.name, originalValue, newValue);
            }}
            onTab={(shiftKey) => {
              const nextCol = shiftKey ? colIdx - 1 : colIdx + 1;
              if (nextCol >= 0 && nextCol < activeResult.columns.length) {
                editingCellRef.current = {
                  rowIndex: rowIdx,
                  colIndex: nextCol,
                };
              }
            }}
          />
        );
      },
      size: Math.max(80, Math.min(350, Math.min(maxContentLen[col.name] ?? 5, 30) * 9 + 40)),
    }));
  }, [activeResult, editing, maxContentLen]);

  const data = useMemo(() => {
    if (!activeResult) return [];
    return activeResult.rows.map((row) => {
      const obj: Record<string, SqlValue> = {};
      activeResult.columns.forEach((col, idx) => {
        obj[col.name] = row[idx];
      });
      return obj;
    });
  }, [activeResult]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnSizing },
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: true,
    columnResizeMode: "onChange",
  });

  // Row virtualization: only render visible rows to avoid DOM bloat
  const ROW_HEIGHT = 32; // px per row
  const totalRows = data.length + (editing.editMode ? editing.inserts.length : 0);
  const shouldVirtualize = totalRows > 5000;

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || totalRows <= 5000) return;
    const SCROLL_BOOST = Math.min(totalRows / 100, 100);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      el.scrollTop += e.deltaY * SCROLL_BOOST;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [totalRows]);

  const rowVirtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    enabled: shouldVirtualize,
    overscan: 5,
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
    const handleFixWithAI = () => {
      if (!aiEnabled) return;
      const editorTab = useEditorStore.getState().tabs.find(
        (t) => t.id === useEditorStore.getState().activeTabId,
      );
      const sql = editorTab?.content ?? "";
      if (!sql.trim()) return;
      useAiStore.getState().sendMessage(
        `Fix this SQL query that produced an error:\n\nQuery:\n\`\`\`sql\n${sql}\n\`\`\`\n\nError:\n${error}`,
      );
    };

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
          {aiEnabled && (
          <button
            onClick={handleFixWithAI}
            className="mt-3 flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 transition-colors"
          >
            <Sparkles className="h-3 w-3" />
            Fix with AI
          </button>
          )}
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
    <div className="flex h-full flex-col min-h-0">
      {/* Edit toolbar */}
      <EditToolbar
        editMode={editing.editMode}
        onToggleEditMode={editing.toggleEditMode}
        pendingCount={editing.pendingCount}
        hasChanges={editing.hasChanges}
        hasPrimaryKey={whereInfo.hasPrimaryKey}
        isSaving={isSaving}
        onAddRow={editing.addRow}
        onSave={handleSave}
        onDiscard={editing.discardAll}
      />

      {/* Truncation warning */}
      {activeResult?.rows_truncated && (
        <div className="flex items-center gap-2 border-b border-amber-800 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            Results truncated to {activeResult.rows.length.toLocaleString()} rows.
            Add a LIMIT clause to fetch fewer rows.
          </span>
        </div>
      )}

      {/* Backend warnings (e.g., memory guard) */}
      {activeResult?.warnings?.map((warning, idx) => (
        <div key={idx} className="flex items-center gap-2 border-b border-yellow-800 bg-yellow-900/20 px-3 py-1.5 text-xs text-yellow-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{warning}</span>
        </div>
      ))}

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
      <div
        ref={(node) => {
          scrollContainerRef.current = node;
        }}
        className="relative flex-1 overflow-auto"
        style={{ scrollbarGutter: "stable" }}
      >
        {shouldVirtualize ? (
          <div style={{ height: `${totalRows * ROW_HEIGHT + ROW_HEIGHT}px`, position: "relative" }}>
            <div className="sticky top-0 z-10 flex text-xs">
              <div className="flex items-center justify-center border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-center font-normal text-[var(--color-text-muted)]" style={{ flex: "0 0 48px" }}>
                #
              </div>
              {table.getFlatHeaders().map((header) => {
                const minW = Math.max(50, Math.min(maxContentLen[header.column.id] ?? 5, 20) * 7 + 30);
                return (
                <div
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  className="relative flex cursor-pointer select-none items-center gap-1 border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-left font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                  style={{ flex: `1 1 ${header.getSize()}px`, minWidth: minW }}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {header.column.getIsSorted() === "asc" && <ArrowUp className="h-3 w-3 shrink-0" />}
                  {header.column.getIsSorted() === "desc" && <ArrowDown className="h-3 w-3 shrink-0" />}
                  {header.column.getCanResize() && (
                    <div
                      onMouseDown={(e) => { e.stopPropagation(); header.getResizeHandler()(e); }}
                      onTouchStart={header.getResizeHandler()}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        const colName = header.column.id;
                        const colIdx = activeResult.columns.findIndex((c) => c.name === colName);
                        let maxLen = colName.length;
                        if (colIdx >= 0) {
                          for (const row of data) {
                            const len = String(row[colName] ?? "").length;
                            if (len > maxLen) maxLen = len;
                          }
                        }
                        const autoWidth = Math.max(80, Math.min(600, Math.min(maxLen, 50) * 9 + 40));
                        table.setColumnSizing((prev) => ({ ...prev, [colName]: autoWidth }));
                      }}
                      className={`absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none select-none ${header.column.getIsResizing() ? "bg-brand-500" : "hover:bg-brand-500/40"}`}
                      title="Drag to resize column"
                    />
                  )}
                </div>
              );
              })}
            </div>
            {/* Virtual rows */}
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const rowIdx = virtualRow.index;
              const isInsert = rowIdx >= data.length;
              const insertIdx = rowIdx - data.length;
              const tableRow = !isInsert ? table.getRowModel().rows[rowIdx] : null;

              if (isInsert && editing.editMode) {
                const insertRow = editing.inserts[insertIdx];
                return (
                  <div
                    key={`insert-${insertIdx}`}
                    style={{
                      display: "flex",
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                      height: `${virtualRow.size}px`,
                    }}
                  >
                    <div className="flex items-center justify-center border-b border-r border-[var(--color-border)] bg-green-900/15 px-2 py-1 text-center text-green-400 text-xs" style={{ flex: "0 0 48px" }}>
                      +
                    </div>
                    {activeResult.columns.map((col, colIdx) => {
                      const header = table.getFlatHeaders()[colIdx + 1];
                      const colSize = header ? header.getSize() : 150;
                      const minW = Math.max(50, Math.min(maxContentLen[col.name] ?? 5, 20) * 7 + 30);
                      return (
                        <div
                          key={col.name}
                          className="border-b border-r border-[var(--color-border)] bg-green-900/15 px-2 py-1 text-xs text-[var(--color-text-primary)]"
                          style={{ flex: `1 1 ${colSize}px`, minWidth: minW }}
                        >
                          <EditableCell
                            value={insertRow[col.name] === undefined ? null : insertRow[col.name]}
                            dataType={col.data_type}
                            isEdited={insertRow[col.name] !== undefined}
                            onCommit={(newValue) => {
                              editing.editInsertCell(insertIdx, col.name, newValue);
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              }

              if (!tableRow) return null;
              const isDeleted = editing.isRowDeleted(rowIdx);
              const isEdited = editing.isRowEdited(rowIdx);
              let rowBg = "";
              if (isDeleted) rowBg = "bg-red-900/20 line-through opacity-60";
              else if (isEdited) rowBg = "bg-amber-900/10";
              else rowBg = "hover:bg-[var(--color-bg-secondary)]";

              return (
                <div
                  key={tableRow.id}
                  onContextMenu={(e) => handleRowContextMenu(e, rowIdx)}
                  style={{
                    display: "flex",
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                    height: `${virtualRow.size}px`,
                  }}
                >
                  <div className={`flex items-center justify-center border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-xs text-[var(--color-text-muted)] ${rowBg}`} style={{ flex: "0 0 48px" }}>
                    {rowIdx + 1}
                  </div>
                  {tableRow.getVisibleCells().map((cell) => {
                    const minW = Math.max(50, Math.min(maxContentLen[cell.column.id] ?? 5, 20) * 7 + 30);
                    return (
                    <div
                      key={cell.id}
                      className={`border-b border-r border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-primary)] ${rowBg}`}
                      style={{ flex: `1 1 ${cell.column.getSize()}px`, minWidth: minW }}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </div>
                  );
                  })}
                </div>
              );
            })}
          </div>
        ) : (
        <table className="border-collapse text-xs" style={{ tableLayout: "fixed", width: "100%" }}>
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="w-12 border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-center font-normal text-[var(--color-text-muted)]">#</th>
                {table.getFlatHeaders().map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="relative cursor-pointer select-none border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-left font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                    style={{ width: header.getSize() }}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === "asc" && <ArrowUp className="h-3 w-3" />}
                      {header.column.getIsSorted() === "desc" && <ArrowDown className="h-3 w-3" />}
                    </div>
                    {header.column.getCanResize() && (
                      <div
                        onMouseDown={(e) => { e.stopPropagation(); header.getResizeHandler()(e); }}
                        onTouchStart={header.getResizeHandler()}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          const colName = header.column.id;
                          const colIdx = activeResult.columns.findIndex((c) => c.name === colName);
                          let maxLen = colName.length;
                          if (colIdx >= 0) {
                            for (const row of data) {
                              const len = String(row[colName] ?? "").length;
                              if (len > maxLen) maxLen = len;
                            }
                          }
                          const autoWidth = Math.max(80, Math.min(600, Math.min(maxLen, 50) * 9 + 40));
                          table.setColumnSizing((prev) => ({ ...prev, [colName]: autoWidth }));
                        }}
                        className={`absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none select-none ${header.column.getIsResizing() ? "bg-brand-500" : "hover:bg-brand-500/40"}`}
                        title="Drag to resize column"
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row, rowIdx) => {
                const isDeleted = editing.isRowDeleted(rowIdx);
                const isEdited = editing.isRowEdited(rowIdx);
                let rowClass = "hover:bg-[var(--color-bg-secondary)]";
                if (isDeleted) rowClass = "bg-red-900/20 line-through opacity-60";
                else if (isEdited) rowClass = "bg-amber-900/10";

                return (
                  <tr
                    key={row.id}
                    className={rowClass}
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
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {editing.editMode &&
                editing.inserts.map((insertRow, insertIdx) => (
                  <tr key={`insert-${insertIdx}`} className="bg-green-900/15">
                    <td className="border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-green-400">
                      +
                    </td>
                    {activeResult.columns.map((col) => (
                      <td
                        key={col.name}
                        className="border-b border-r border-[var(--color-border)] px-2 py-1 text-[var(--color-text-primary)]"
                      >
                        <EditableCell
                          value={
                            insertRow[col.name] === undefined
                              ? null
                              : insertRow[col.name]
                          }
                          dataType={col.data_type}
                          isEdited={insertRow[col.name] !== undefined}
                          onCommit={(newValue) => {
                            editing.editInsertCell(insertIdx, col.name, newValue);
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {activeResult.rows.length} row(s) &middot;{" "}
          {activeResult.execution_time_ms}ms
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
      <CellViewerModal
        isOpen={cellViewer.isOpen}
        columnName={cellViewer.columnName}
        content={cellViewer.content}
        dataType={cellViewer.dataType}
        onClose={() =>
          setCellViewer({ isOpen: false, columnName: "", content: null })
        }
      />
    </div>
  );
}
