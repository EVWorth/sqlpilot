import { type SortingState, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef, useState } from "react";
import { useColumnFilters } from "../../hooks/useColumnFilters";
import { useColumnLayout } from "../../hooks/useColumnLayout";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useGridColumns } from "../../hooks/useGridColumns";
import { useGridContextMenu } from "../../hooks/useGridContextMenu";
import { useGridEditing } from "../../hooks/useGridEditing";
import { useGridExport } from "../../hooks/useGridExport";
import { useGridSave } from "../../hooks/useGridSave";
import { useGridShortcuts } from "../../hooks/useGridShortcuts";
import { useRowCount } from "../../hooks/useRowCount";
import { useRowKey } from "../../hooks/useRowKey";
import { useRowSelection } from "../../hooks/useRowSelection";
import { gridFeatures } from "../../lib/grid-features";
import { columnTypesOf } from "../../lib/sql-generator";
import { isNumericSqlType } from "../../lib/sql-types";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import type { SqlValue } from "../../types";
import { CellViewerModal } from "./CellViewerModal";
import { EditToolbar } from "./EditToolbar";
import { GridBanners } from "./GridBanners";
import { GridFooter } from "./GridFooter";
import { GridHeaderRow } from "./GridHeaderRow";
import { GridPlaceholder } from "./GridPlaceholder";
import { TableGridRows, VirtualGridRows } from "./GridRows";

function ExportToast({ message }: { message: string }) {
  return (
    <div className="animate-fade-out pointer-events-none fixed bottom-4 right-4 z-50 rounded bg-brand-600 px-3 py-1.5 text-xs text-white shadow-lg">
      {message}
    </div>
  );
}

export function ResultsGrid() {
  const results = useResultStore((s) => s.results);
  const activeResultIndex = useResultStore((s) => s.activeResultIndex);
  const isExecuting = useResultStore((s) => s.isExecuting);
  const error = useResultStore((s) => s.error);
  const page = useResultStore((s) => s.page);
  const goToPage = useResultStore((s) => s.goToPage);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState<{ dragging: string | null; over: string | null }>({
    dragging: null,
    over: null,
  });
  const [toast, setToast] = useState<string | null>(null);
  const [cellViewer, setCellViewer] = useState<{
    isOpen: boolean;
    columnName: string;
    content: string | null;
    /** Set for a binary column, whose value is bytes rather than text (#401). */
    bytes?: number[];
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

  const gridRef = useRef<HTMLDivElement | null>(null);

  const editing = useGridEditing();

  const activeResult = results[activeResultIndex];

  const activeEditorTab = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const gridConnectionId = activeEditorTab?.connectionId ?? selectedConnectionId;
  const gridDatabase = activeEditorTab?.database ?? null;

  // FR-3.1.5: a dragged column order outlives the query that produced it.
  const layout = useColumnLayout(gridConnectionId, gridDatabase, activeResult?.columns);
  const { columnOrder, orderedColumns, layoutId } = layout;

  const filters = useColumnFilters(layoutId);
  const columnFilters = filters.active;

  const { selection, clickRow } = useRowSelection(
    activeResult?.rows.length ?? 0,
    layoutId,
    gridRef,
  );

  const rowCount = useRowCount(
    gridConnectionId,
    gridDatabase,
    activeResult?.sql,
    Boolean(activeResult?.rows_truncated),
  );

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

  const { setCellNull } = useGridShortcuts({ result: activeResult, editing, editingCell });

  const { copyAll, copyAs, exportAs } = useGridExport({
    result: activeResult,
    orderedColumns,
    selection,
    rowKey,
    onMessage: showToast,
  });

  const handleRowContextMenu = useGridContextMenu({
    result: activeResult,
    orderedColumns,
    selection,
    editing,
    showContextMenu,
    onCopyAs: copyAs,
    onSetNull: setCellNull,
  });

  const { isSaving, save } = useGridSave({
    result: activeResult,
    editing,
    rowKey,
    keyWarning,
    columnTypes,
    onMessage: showToast,
  });

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

  const columns = useGridColumns({
    result: activeResult,
    editing,
    editingCell,
    maxContentLen,
    onEditCellAt: editCellAt,
    onStopEditing: stopEditing,
    onViewCell: setCellViewer,
  });

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
    onColumnOrderChange: layout.setColumnOrder,
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

  // Running, failed, a statement that returned a count, or nothing run yet —
  // none of which is a grid.
  if (isExecuting || error || !activeResult || activeResult.columns.length === 0) {
    return <GridPlaceholder isExecuting={isExecuting} error={error} result={activeResult} />;
  }

  return (
    // tabIndex so the grid can hold focus, which is what scopes Ctrl+A to it.
    <div ref={gridRef} tabIndex={-1} className="flex h-full flex-col min-h-0 outline-none">
      {/* Edit toolbar */}
      <EditToolbar
        editMode={editing.editMode}
        onToggleEditMode={editing.toggleEditMode}
        pendingCount={editing.pendingCount}
        hasChanges={editing.hasChanges}
        keyWarning={keyWarning}
        isSaving={isSaving}
        onAddRow={editing.addRow}
        onSave={() => void save()}
        onDiscard={editing.discardAll}
        onUndo={editing.undo}
        onRedo={editing.redo}
        canUndo={editing.canUndo}
        canRedo={editing.canRedo}
      />

      <GridBanners
        rowsShown={activeResult.rows.length}
        truncated={Boolean(activeResult.rows_truncated)}
        truncationReason={activeResult.truncation_reason}
        warnings={activeResult.warnings}
        rowCount={rowCount}
      />

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
                <GridHeaderRow
                  headers={table.getFlatHeaders()}
                  as="div"
                  sortedColumnCount={sortedColumnCount}
                  columnTypes={columnTypes}
                  numericColumns={numericColumns}
                  maxContentLen={maxContentLen}
                  filters={filters}
                  layout={layout}
                  drag={drag}
                  onDragStateChange={(next) => setDrag((prev) => ({ ...prev, ...next }))}
                  onAutoSize={autoSizeColumn}
                />
              </div>
              <VirtualGridRows
                table={table}
                data={data}
                editing={editing}
                editingCell={editingCell}
                selection={selection}
                orderedColumns={orderedColumns}
                maxContentLen={maxContentLen}
                numericColumns={numericColumns}
                insertRowIndex={insertRowIndex}
                onEditCellAt={editCellAt}
                onStopEditing={stopEditing}
                onClickRow={clickRow}
                onRowContextMenu={handleRowContextMenu}
                rowVirtualizer={rowVirtualizer}
                rowHeight={ROW_HEIGHT}
              />
            </div>
          )
          : (
            <table className="border-separate border-spacing-0 text-xs" style={{ tableLayout: "fixed", width: "100%" }}>
              <thead className="sticky top-0 z-10 bg-[var(--color-bg-tertiary)]">
                <tr>
                  <th className="w-12 border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-center font-normal text-[var(--color-text-muted)]">
                    #
                  </th>
                  <GridHeaderRow
                    headers={table.getFlatHeaders()}
                    as="th"
                    sortedColumnCount={sortedColumnCount}
                    columnTypes={columnTypes}
                    numericColumns={numericColumns}
                    maxContentLen={maxContentLen}
                    filters={filters}
                    layout={layout}
                    drag={drag}
                    onDragStateChange={(next) => setDrag((prev) => ({ ...prev, ...next }))}
                    onAutoSize={autoSizeColumn}
                  />
                </tr>
              </thead>
              <tbody>
                <TableGridRows
                  table={table}
                  data={data}
                  editing={editing}
                  editingCell={editingCell}
                  selection={selection}
                  orderedColumns={orderedColumns}
                  maxContentLen={maxContentLen}
                  numericColumns={numericColumns}
                  insertRowIndex={insertRowIndex}
                  onEditCellAt={editCellAt}
                  onStopEditing={stopEditing}
                  onClickRow={clickRow}
                  onRowContextMenu={handleRowContextMenu}
                />
              </tbody>
            </table>
          )}
      </div>

      <GridFooter
        rowsShown={activeResult.rows.length}
        rowsAfterFilter={table.getRowModel().rows.length}
        executionTimeMs={activeResult.execution_time_ms}
        page={page}
        isExecuting={isExecuting}
        onGoToPage={(index) => void goToPage(index)}
        filterCount={columnFilters.length}
        describeFilters={filters.describe}
        onClearFilters={filters.clear}
        isReordered={layout.isReordered}
        onResetColumns={layout.reset}
        onCopy={() => void copyAll()}
        onExport={(format) => void exportAs(format)}
      />

      {toast && <ExportToast message={toast} />}
      {contextMenu}
      <CellViewerModal
        isOpen={cellViewer.isOpen}
        columnName={cellViewer.columnName}
        content={cellViewer.content}
        bytes={cellViewer.bytes}
        dataType={cellViewer.dataType}
        onClose={() => setCellViewer({ isOpen: false, columnName: "", content: null })}
      />
    </div>
  );
}
