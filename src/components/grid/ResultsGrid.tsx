import {
  type ColumnDef,
  columnFilteringFeature,
  columnOrderingFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  AlertTriangle,
  ClipboardCopy,
  ClipboardList,
  Copy,
  FileCode,
  FileJson,
  FileSpreadsheet,
  FileText,
  FilterX,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useGridEditing } from "../../hooks/useGridEditing";
import { useRowKey } from "../../hooks/useRowKey";
import { type ColumnFilter, describeFilter, isActiveFilter, matchesFilter } from "../../lib/grid-filter";
import { applyOrder, layoutKey, moveColumn, readLayout, writeLayout } from "../../lib/grid-layout";
import { describeGridChanges, nextEditableCell } from "../../lib/grid-navigation";
import { runStatement } from "../../lib/run-statement";
import {
  columnTypesOf,
  generateDelete,
  generateInsert,
  generateUpdate,
  resolveEditTarget,
} from "../../lib/sql-generator";
import { quoteIdentifier } from "../../lib/sql-quote";
import { isNumericSqlType } from "../../lib/sql-types";
import { api } from "../../lib/tauri-api";
import { truncationMessage } from "../../lib/truncation";
import { useAiStore } from "../../stores/aiStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { confirmDestructive } from "../../stores/productionGuardStore";
import { useResultStore } from "../../stores/resultStore";
import type { SqlValue } from "../../types";
import { SqlValueGuard } from "../../types";
import type { MenuItem } from "../common/ContextMenu";
import { CellViewerModal } from "./CellViewerModal";
import { ColumnFilterMenu } from "./ColumnFilterMenu";
import { EditableCell } from "./EditableCell";
import { EditToolbar } from "./EditToolbar";
import { GridHeaderCell } from "./GridHeaderCell";
import { TruncatedCell } from "./TruncatedCell";

/**
 * v9 requires features to be declared up front rather than bundling every
 * one. The grid only sorts and resizes columns, so opting in to just those
 * keeps the rest (filtering, pagination, grouping, …) out of the bundle.
 * Module scope: this must be a stable reference across renders.
 */
const gridFeatures = tableFeatures({
  rowSortingFeature,
  // FR-3.1.5: dragging a header changes the display order (#392).
  columnOrderingFeature,
  // FR-3.1.3: per-column filters over the rows already fetched (#391).
  columnFilteringFeature,
  columnSizingFeature,
  columnResizingFeature,
  // Not for hiding columns — row.getVisibleCells() hangs off this feature.
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
});

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
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const [drag, setDrag] = useState<{ dragging: string | null; over: string | null }>({
    dragging: null,
    over: null,
  });
  const [toast, setToast] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [cellViewer, setCellViewer] = useState<{
    isOpen: boolean;
    columnName: string;
    content: string | null;
    dataType?: string;
  }>({ isOpen: false, columnName: "", content: null });
  const { contextMenu, showContextMenu } = useContextMenu();
  /**
   * Which cell is being edited, if any.
   *
   * State rather than a ref, and owned here rather than by the cell: Tab has
   * to move the edit onwards, and a cell cannot put another cell into edit
   * mode. The old ref was written on Tab and read by nothing, so focus fell
   * through to the next thing in the document — usually a footer button
   * (#408).
   *
   * Pending insert rows use negative indices, so one piece of state covers
   * both grids without the two ever colliding.
   */
  const [editingCell, setEditingCell] = useState<
    { rowIndex: number; colIndex: number } | null
  >(null);

  const insertRowIndex = (insertIdx: number) => -1 - insertIdx;

  const editCellAt = useCallback((rowIndex: number, colIndex: number) => {
    setEditingCell({ rowIndex, colIndex });
  }, []);

  const stopEditing = useCallback(() => setEditingCell(null), []);

  const editing = useGridEditing();

  // Keyboard shortcuts for grid edit undo/redo
  useEffect(() => {
    if (!editing.editMode) return;
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.shiftKey && e.key === "z") {
        e.preventDefault();
        editing.redo();
      } else if (e.key === "z") {
        e.preventDefault();
        editing.undo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editing.editMode, editing.undo, editing.redo]);

  const activeResult = results[activeResultIndex];
  const aiEnabled = useAiStore((s) => s.aiEnabled);

  const activeEditorTab = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const gridConnectionId = activeEditorTab?.connectionId ?? selectedConnectionId;
  const gridDatabase = activeEditorTab?.database ?? null;

  // FR-3.1.5: a dragged column order outlives the query that produced it.
  const resultColumnNames = useMemo(
    () => activeResult?.columns.map((c) => c.name) ?? [],
    [activeResult],
  );
  const layoutId = useMemo(
    () => layoutKey(gridConnectionId, gridDatabase, resultColumnNames),
    [gridConnectionId, gridDatabase, resultColumnNames],
  );

  useEffect(() => {
    if (resultColumnNames.length === 0) {
      setColumnOrder([]);
      return;
    }
    setColumnOrder(applyOrder(readLayout(layoutId)?.columnOrder ?? [], resultColumnNames));
  }, [layoutId, resultColumnNames]);

  const reorderColumn = useCallback((from: string, to: string) => {
    setColumnOrder((prev) => {
      const next = moveColumn(prev.length > 0 ? prev : resultColumnNames, from, to);
      writeLayout(layoutId, { columnOrder: next });
      return next;
    });
  }, [layoutId, resultColumnNames]);

  /**
   * The result's columns in display order.
   *
   * Pending insert rows are rendered from this rather than from the raw
   * result: they are laid out cell by cell to sit under the headers, so
   * iterating the query's own order would put every value under the wrong
   * column as soon as one was dragged (#392).
   */
  const orderedColumns = useMemo(() => {
    const cols = activeResult?.columns ?? [];
    if (columnOrder.length === 0) return cols;
    const byName = new Map(cols.map((c) => [c.name, c]));
    return columnOrder.map((name) => byName.get(name)).filter((c) => c !== undefined);
  }, [activeResult, columnOrder]);

  /**
   * The filters that would actually narrow something, in TanStack's shape.
   *
   * A half-written filter is left out rather than applied: opening a menu and
   * picking an operator should not empty the grid before an operand is typed.
   */
  const columnFilters = useMemo(
    () =>
      Object.entries(filters)
        .filter(([, f]) => isActiveFilter(f))
        .map(([id, value]) => ({ id, value })),
    [filters],
  );

  const setColumnFilter = useCallback((column: string, filter: ColumnFilter | undefined) => {
    setFilters((prev) => {
      if (!filter) {
        const { [column]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [column]: filter };
    });
  }, []);

  const clearFilters = useCallback(() => setFilters({}), []);

  // A filter is about the rows on screen, so it has no meaning once they are
  // replaced by a different query's.
  useEffect(() => setFilters({}), [layoutId]);

  /** True when what is on screen is not the order the query returned. */
  const isReordered = useMemo(
    () =>
      columnOrder.length === resultColumnNames.length
      && columnOrder.some((name, i) => name !== resultColumnNames[i]),
    [columnOrder, resultColumnNames],
  );

  const resetColumnOrder = useCallback(() => {
    setColumnOrder(resultColumnNames);
    writeLayout(layoutId, { columnOrder: resultColumnNames });
  }, [layoutId, resultColumnNames]);

  // Resolved when the result arrives rather than when Save is pressed, so the
  // user learns their edits are addressable before making them (#387, #400).
  // The result's own SQL, not the editor's current text: the user keeps typing
  // after running, and the grid still shows what the earlier statement returned.
  const rowKey = useRowKey(
    gridConnectionId,
    gridDatabase,
    activeResult?.sql,
    activeResult?.columns,
  );

  const keyWarning = useMemo(() => {
    switch (rowKey.state.status) {
      case "no-key":
        return `${rowKey.state.table} has no primary key and no unique index over NOT NULL `
          + `columns, so edits match on every column and may affect more than one row.`;
      case "key-not-selected": {
        const what = rowKey.state.source === "primary-key"
          ? "primary key"
          : "unique index";
        return `This query does not select ${rowKey.state.table}'s ${what} `
          + `(${rowKey.state.columns.join(", ")}), so rows cannot be identified. `
          + `Add it to the SELECT to edit here.`;
      }
      default:
        return null;
    }
  }, [rowKey.state]);

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

  /**
   * Columns holding numbers, by name.
   *
   * Driven by the declared column type rather than the value's JavaScript
   * type, because BIGINT and DECIMAL arrive as strings. Same reason SQLyog
   * aligns from IS_NUM(field->type).
   */
  const numericColumns = useMemo(
    () =>
      new Set(
        (activeResult?.columns ?? [])
          .filter((c) => isNumericSqlType(c.data_type))
          .map((c) => c.name),
      ),
    [activeResult],
  );

  /** Column name -> SQL type, so numeric-but-stringified values stay unquoted. */
  const columnTypes = useMemo(
    () => (activeResult ? columnTypesOf(activeResult.columns) : {}),
    [activeResult],
  );

  const formatSqlVal = useCallback(
    (val: SqlValue, columnName?: string): string =>
      SqlValueGuard.toSqlLiteral(val, columnName ? columnTypes[columnName] : undefined),
    [columnTypes],
  );

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

      // The statement has to name a table that exists. It used to say
      // `your_table`, so pasting it produced "Table 'db.your_table' doesn't
      // exist" — or, on the one schema where that name is real, wrote a row
      // into it (#409).
      //
      // Same resolver as Save, and for the same reason: a join or a CTE
      // selects columns that belong to more than one table, so there is no
      // single table an INSERT of this row could target.
      const insertTarget = resolveEditTarget(
        useEditorStore.getState().tabs.find(
          (tab) => tab.id === useEditorStore.getState().activeTabId,
        )?.content ?? "",
      );
      const insertCols = colNames.map(quoteIdentifier).join(", ");
      const insertVals = row.map((v, i) => formatSqlVal(v, colNames[i])).join(", ");
      const insertStmt = insertTarget.editable
        ? `INSERT INTO ${quoteIdentifier(insertTarget.table)} (${insertCols}) VALUES (${insertVals});`
        : null;
      const insertRefusal = insertTarget.editable
        ? undefined
        : `Copy as INSERT needs one source table: ${insertTarget.reason}`;

      const allRowsTsv = [
        colNames.join("\t"),
        ...activeResult.rows.map((r) => r.map((v) => SqlValueGuard.toString(v)).join("\t")),
      ].join("\n");

      // Annotated: without it the separators widen to `separator: boolean`
      // and stop matching the union.
      const menuItems: MenuItem[] = [
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
          disabled: insertStmt === null,
          title: insertRefusal,
          onClick: () => {
            if (insertStmt !== null) navigator.clipboard.writeText(insertStmt);
          },
        },
        { separator: true },
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
          { separator: true },
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

    // Where the edit would land, or why it must not be attempted. The old
    // check took the first table in the FROM clause, which for a join is
    // whichever is listed first — not necessarily the one that owns the
    // edited column (#399).
    const target = resolveEditTarget(sql);
    if (!target.editable) {
      showToast(`Cannot save: ${target.reason}`);
      return;
    }
    const tableName = target.table;

    const connId = editorTab?.connectionId
      ?? useConnectionStore.getState().selectedConnectionId;
    if (!connId) {
      showToast("No active connection");
      return;
    }

    setIsSaving(true);
    try {
      // Already resolved when the result loaded, so Save does not repeat the
      // schema read and the user was warned before editing rather than after.
      if (rowKey.state.status === "key-not-selected") {
        showToast(`Cannot save: ${keyWarning ?? "rows cannot be identified"}`);
        setIsSaving(false);
        return;
      }
      const keyColumns = rowKey.columns;

      const statements: string[] = [];

      // Generate UPDATE statements
      for (const [rowIdx, changes] of editing.updates) {
        const originalRow = getOriginalRow(rowIdx);
        statements.push(
          generateUpdate(
            tableName,
            keyColumns,
            originalRow,
            changes.map((c) => ({ column: c.column, newValue: c.newValue })),
            columnTypes,
          ),
        );
      }

      // Generate INSERT statements
      for (const insertRow of editing.inserts) {
        const cols = activeResult.columns.map((c) => c.name);
        statements.push(generateInsert(tableName, cols, insertRow, columnTypes));
      }

      // Generate DELETE statements
      for (const rowIdx of editing.deletes) {
        const originalRow = getOriginalRow(rowIdx);
        statements.push(
          generateDelete(tableName, keyColumns, originalRow, columnTypes),
        );
      }

      // Execute all statements as a single transactional batch.
      // Wrap in a transaction so partial failures roll back.
      let matched = 0;
      if (statements.length > 0) {
        // The gate lives in resultStore, which this path does not go through
        // — so until #588 a cell edit on production wrote with no
        // confirmation at all. Asked once for the batch, and about every
        // write rather than only the destructive verbs, because editing a
        // cell is direct manipulation rather than a composed statement.
        const confirmed = await confirmDestructive({
          connectionId: connId,
          sql: statements,
          action: `Apply ${statements.length} change(s) to \`${tableName}\`?`,
          detail: describeGridChanges({
            updates: editing.updates.size,
            inserts: editing.inserts.length,
            deletes: editing.deletes.size,
          }),
          alwaysAsk: true,
        });
        if (!confirmed) {
          setIsSaving(false);
          return;
        }

        const batch = "START TRANSACTION;\n" + statements.join(";\n") + ";\nCOMMIT;";
        const results = await runStatement({
          connectionId: connId,
          sql: batch,
          origin: "grid",
        });
        matched = results.reduce((sum, r) => sum + Number(r.rows_affected ?? 0), 0);
      }

      // Re-run original query to refresh
      editing.discardAll();
      await useResultStore.getState().executeQuery(connId, sql);

      // A WHERE that matches nothing is not an error — the statement runs and
      // affects zero rows — so the save reported success either way (#419).
      if (statements.length > 0 && matched < statements.length) {
        showToast(
          `Only ${matched} of ${statements.length} change(s) matched a row. The rest changed `
            + `nothing — the values they matched on may no longer be in the table.`,
        );
      } else {
        showToast(`Applied ${statements.length} change(s)`);
      }
    } catch (e) {
      showToast(`Save failed: ${String(e)}`);
    } finally {
      setIsSaving(false);
    }
  }, [activeResult, editing, getOriginalRow, rowKey, keyWarning, showToast, columnTypes]);

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

  const columns = useMemo<ColumnDef<typeof gridFeatures, Record<string, unknown>>[]>(() => {
    if (!activeResult) return [];

    return activeResult.columns.map((col, colIdx) => ({
      id: col.name,
      accessorKey: col.name,
      header: col.name,
      // The filter value is our own ColumnFilter rather than a bare string,
      // because an operator and an operand cannot be carried by one (#391).
      filterFn: (row, columnId, value) => matchesFilter(row.getValue(columnId), value as ColumnFilter),
      cell: ({ getValue, row }) => {
        const rowIdx = row.index;
        const originalValue = getValue() as SqlValue;

        if (!editing.editMode) {
          return (
            <TruncatedCell
              value={originalValue}
              columnName={col.name}
              dataType={col.data_type}
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
            editing={editingCell?.rowIndex === rowIdx && editingCell?.colIndex === colIdx}
            onEditingChange={(on) => (on ? editCellAt(rowIdx, colIdx) : stopEditing())}
            onTab={(shiftKey) => {
              const next = nextEditableCell(
                { rowIndex: rowIdx, colIndex: colIdx },
                shiftKey,
                activeResult.rows.length,
                activeResult.columns.length,
              );
              if (!next) {
                stopEditing();
                return;
              }
              editCellAt(next.rowIndex, next.colIndex);
            }}
          />
        );
      },
      size: Math.max(80, Math.min(350, Math.min(maxContentLen[col.name] ?? 5, 30) * 9 + 40)),
    }));
    // editingCell belongs here: the cell renderers close over it, so leaving
    // it out would keep rendering the previously-memoised cells and the edit
    // would never appear to move.
  }, [activeResult, editing, editingCell, editCellAt, stopEditing, maxContentLen]);

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

  const table = useTable({
    features: gridFeatures,
    data,
    columns,
    state: { sorting, columnSizing, columnOrder, columnFilters },
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    onColumnOrderChange: setColumnOrder,
    // The grid owns the filter state so the menus can edit it directly; this
    // feeds TanStack the derived form it filters with.
    // The menus own the filter state so they can edit operator and operand
    // together; this hands TanStack the derived list it filters with.
    onColumnFiltersChange: () => {},
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    // FR-3.1.2. Shift adds a sort key rather than replacing one, so
    // "department, then hire_date" is expressible; without it only the last
    // click counted (#392).
    enableMultiSort: true,
    isMultiSortEvent: (e) => Boolean((e as MouseEvent).shiftKey),
    // FR-3.1.2 says ASC then DESC. TanStack infers descending-first for
    // numeric columns, so clicking `id` and clicking `name` sorted opposite
    // ways for no reason the user could see.
    sortDescFirst: false,
  });

  /** Widen a column to fit its widest value, capped so one JSON blob cannot own the grid. */
  const autoSizeColumn = useCallback((colName: string) => {
    let maxLen = colName.length;
    for (const row of data) {
      const len = String(row[colName] ?? "").length;
      if (len > maxLen) maxLen = len;
    }
    table.setColumnSizing((prev) => ({
      ...prev,
      [colName]: Math.max(80, Math.min(600, Math.min(maxLen, 50) * 9 + 40)),
    }));
  }, [data, table]);

  const sortedColumnCount = sorting.length;

  // Row virtualization: only render visible rows to avoid DOM bloat
  const ROW_HEIGHT = 32; // px per row
  const totalRows = data.length + (editing.editMode ? editing.inserts.length : 0);
  const shouldVirtualize = totalRows > 5000;

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

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
        keyWarning={keyWarning}
        isSaving={isSaving}
        onAddRow={editing.addRow}
        onSave={handleSave}
        onDiscard={editing.discardAll}
        onUndo={editing.undo}
        onRedo={editing.redo}
        canUndo={editing.canUndo}
        canRedo={editing.canRedo}
      />

      {/* Truncation warning */}
      {activeResult?.rows_truncated && (
        <div className="flex items-center gap-2 border-b border-amber-800 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            {truncationMessage(activeResult.rows.length, activeResult.truncation_reason)}
          </span>
        </div>
      )}

      {/* Backend warnings (e.g., memory guard) */}
      {activeResult?.warnings?.map((warning, idx) => (
        <div
          key={idx}
          className="flex items-center gap-2 border-b border-yellow-800 bg-yellow-900/20 px-3 py-1.5 text-xs text-yellow-400"
        >
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
              className={`px-3 py-1 text-xs ${
                idx === activeResultIndex
                  ? "border-b-2 border-brand-500 text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-muted)]"
              }`}
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
        className="isolate relative z-0 flex-1 overflow-auto"
        style={{ scrollbarGutter: "stable" }}
      >
        {shouldVirtualize
          ? (
            <div style={{ height: `${totalRows * ROW_HEIGHT + ROW_HEIGHT}px`, position: "relative" }}>
              <div className="sticky top-0 z-10 flex bg-[var(--color-bg-tertiary)] text-xs">
                <div
                  className="flex items-center justify-center border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-center font-normal text-[var(--color-text-muted)]"
                  style={{ flex: "0 0 48px" }}
                >
                  #
                </div>
                {table.getFlatHeaders().map((header) => {
                  const minW = Math.max(50, Math.min(maxContentLen[header.column.id] ?? 5, 20) * 7 + 30);
                  return (
                    <GridHeaderCell
                      as="div"
                      key={header.id}
                      columnId={header.column.id}
                      label={flexRender(header.column.columnDef.header, header.getContext())}
                      sortDirection={header.column.getIsSorted()}
                      sortIndex={header.column.getSortIndex() + 1}
                      showSortPriority={sortedColumnCount > 1}
                      numeric={numericColumns.has(header.column.id)}
                      canResize={header.column.getCanResize()}
                      isResizing={header.column.getIsResizing()}
                      onSort={(e) => header.column.getToggleSortingHandler()?.(e)}
                      onResizeStart={(e) => header.getResizeHandler()(e)}
                      onAutoSize={() => autoSizeColumn(header.column.id)}
                      filterMenu={
                        <ColumnFilterMenu
                          column={header.column.id}
                          dataType={columnTypes[header.column.id]}
                          filter={filters[header.column.id]}
                          onChange={(next) => setColumnFilter(header.column.id, next)}
                        />
                      }
                      onDropColumn={(from) => reorderColumn(from, header.column.id)}
                      isDropTarget={drag.over === header.column.id
                        && drag.dragging !== header.column.id}
                      onDragStateChange={(next) => setDrag((prev) => ({ ...prev, ...next }))}
                      className="group flex items-center gap-1"
                      style={{ flex: `1 1 ${header.getSize()}px`, minWidth: minW }}
                    />
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
                      <div
                        className="flex items-center justify-center border-b border-r border-[var(--color-border)] bg-green-900/15 px-2 py-1 text-center text-green-400 text-xs"
                        style={{ flex: "0 0 48px" }}
                      >
                        +
                      </div>
                      {orderedColumns.map((col, colIdx) => {
                        // Not colIdx + 1: the row-number column is markup
                        // beside the table, not one of its columns, so the
                        // offset read every insert cell's width from its
                        // neighbour.
                        const header = table.getFlatHeaders()[colIdx];
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
                              editing={editingCell?.rowIndex === insertRowIndex(insertIdx)
                                && editingCell?.colIndex === colIdx}
                              onEditingChange={(on) =>
                                on ? editCellAt(insertRowIndex(insertIdx), colIdx) : stopEditing()}
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
                    <div
                      className={`flex items-center justify-center border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-xs text-[var(--color-text-muted)] ${rowBg}`}
                      style={{ flex: "0 0 48px" }}
                    >
                      {rowIdx + 1}
                    </div>
                    {tableRow.getVisibleCells().map((cell) => {
                      const minW = Math.max(50, Math.min(maxContentLen[cell.column.id] ?? 5, 20) * 7 + 30);
                      return (
                        <div
                          key={cell.id}
                          className={`border-b border-r border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-primary)] ${rowBg} ${
                            numericColumns.has(cell.column.id) ? "text-right tabular-nums" : ""
                          }`}
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
          )
          : (
            <table className="border-separate border-spacing-0 text-xs" style={{ tableLayout: "fixed", width: "100%" }}>
              <thead className="sticky top-0 z-10 bg-[var(--color-bg-tertiary)]">
                <tr>
                  <th className="w-12 border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-center font-normal text-[var(--color-text-muted)]">
                    #
                  </th>
                  {table.getFlatHeaders().map((header) => (
                    <GridHeaderCell
                      as="th"
                      key={header.id}
                      columnId={header.column.id}
                      label={flexRender(header.column.columnDef.header, header.getContext())}
                      sortDirection={header.column.getIsSorted()}
                      sortIndex={header.column.getSortIndex() + 1}
                      showSortPriority={sortedColumnCount > 1}
                      numeric={numericColumns.has(header.column.id)}
                      canResize={header.column.getCanResize()}
                      isResizing={header.column.getIsResizing()}
                      onSort={(e) => header.column.getToggleSortingHandler()?.(e)}
                      onResizeStart={(e) => header.getResizeHandler()(e)}
                      onAutoSize={() => autoSizeColumn(header.column.id)}
                      filterMenu={
                        <ColumnFilterMenu
                          column={header.column.id}
                          dataType={columnTypes[header.column.id]}
                          filter={filters[header.column.id]}
                          onChange={(next) => setColumnFilter(header.column.id, next)}
                        />
                      }
                      onDropColumn={(from) => reorderColumn(from, header.column.id)}
                      isDropTarget={drag.over === header.column.id
                        && drag.dragging !== header.column.id}
                      onDragStateChange={(next) => setDrag((prev) => ({ ...prev, ...next }))}
                      className="group"
                      style={{ width: header.getSize() }}
                    />
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
                          className={`border-b border-r border-[var(--color-border)] px-2 py-1 text-[var(--color-text-primary)] ${
                            numericColumns.has(cell.column.id) ? "text-right tabular-nums" : ""
                          }`}
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
                {editing.editMode
                  && editing.inserts.map((insertRow, insertIdx) => (
                    <tr key={`insert-${insertIdx}`} className="bg-green-900/15">
                      <td className="border-b border-r border-[var(--color-border)] px-2 py-1 text-center text-green-400">
                        +
                      </td>
                      {orderedColumns.map((col, colIdx) => (
                        <td
                          key={col.name}
                          data-column={col.name}
                          className="border-b border-r border-[var(--color-border)] px-2 py-1 text-[var(--color-text-primary)]"
                        >
                          <EditableCell
                            value={insertRow[col.name] === undefined
                              ? null
                              : insertRow[col.name]}
                            dataType={col.data_type}
                            isEdited={insertRow[col.name] !== undefined}
                            onCommit={(newValue) => {
                              editing.editInsertCell(insertIdx, col.name, newValue);
                            }}
                            editing={editingCell?.rowIndex === insertRowIndex(insertIdx)
                              && editingCell?.colIndex === colIdx}
                            onEditingChange={(on) => on ? editCellAt(insertRowIndex(insertIdx), colIdx) : stopEditing()}
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
          {columnFilters.length > 0
            // Saying only "12 row(s)" under an active filter reads as the
            // query having returned twelve, which is a different fact (#391).
            ? `${table.getRowModel().rows.length} of ${activeResult.rows.length} row(s)`
            : `${activeResult.rows.length} row(s)`} &middot; {activeResult.execution_time_ms}ms
        </span>
        <div className="flex items-center gap-1">
          {columnFilters.length > 0 && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-brand-400 hover:bg-[var(--color-bg-tertiary)]"
              title={columnFilters.map((f) => describeFilter(f.id, f.value as ColumnFilter)).join(
                "; ",
              )}
            >
              <FilterX className="h-3 w-3" />
              Clear {columnFilters.length} filter{columnFilters.length === 1 ? "" : "s"}
            </button>
          )}
          {isReordered && (
            // A dragged order outlives the query, so without a way back a
            // stray drag is permanent (#392).
            <button
              onClick={resetColumnOrder}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
              title="Put the columns back in the order the query returned them"
            >
              <RotateCcw className="h-3 w-3" /> Reset columns
            </button>
          )}
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
        onClose={() => setCellViewer({ isOpen: false, columnName: "", content: null })}
      />
    </div>
  );
}
