import { type SortingState, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { recallGrid, useKeepGridOnUnmount } from "../../lib/grid-memory";
import { columnTypesOf } from "../../lib/sql-generator";
import { isNumericSqlType } from "../../lib/sql-types";
import { useResultStore } from "../../stores/resultStore";
import type { SqlValue } from "../../types";
import { CellViewerModal } from "./CellViewerModal";
import { EditToolbar } from "./EditToolbar";
import { GridBanners } from "./GridBanners";
import { GridCellContext, type GridCellState } from "./GridCell";
import { GridFooter } from "./GridFooter";
import { GridHeaderRow } from "./GridHeaderRow";
import { GridPlaceholder, QueryErrorBox } from "./GridPlaceholder";
import { TableGridRows, VirtualGridRows } from "./GridRows";
import { ResultTabs } from "./ResultTabs";

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
  const failedStatement = useResultStore((s) => s.failedStatement);
  const executionStartedAt = useResultStore((s) => s.executionStartedAt);
  const cancelledAfterMs = useResultStore((s) => s.cancelledAfterMs);
  const page = useResultStore((s) => s.page);
  const goToPage = useResultStore((s) => s.goToPage);
  // The tab this grid is mounted for; MainPanel remounts it per tab. What the
  // grid holds that the store does not — pending edits, Edit Mode, sort and
  // column widths — is kept for the tab while it is hidden (#842).
  const viewTabId = useResultStore((s) => s.viewTabId);
  const [memoryTab] = useState(viewTabId);
  // Edits are keyed by row index within one result set, so they belong to the
  // set on screen, not the whole run: switching to another of the run's sets
  // must not carry them over to its rows, or its table (#869).
  const editOwner = results[activeResultIndex] ?? results;
  const memory = useMemo(() => (memoryTab ? { tab: memoryTab, owner: editOwner } : null), [memoryTab, editOwner]);
  const [sorting, setSorting] = useState<SortingState>(() => recallGrid(memory, "sorting") ?? []);
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>(
    () => recallGrid(memory, "columnSizing") ?? {},
  );
  useKeepGridOnUnmount(memory, "sorting", sorting.length > 0 ? sorting : undefined);
  useKeepGridOnUnmount(memory, "columnSizing", Object.keys(columnSizing).length > 0 ? columnSizing : undefined);
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

  const editing = useGridEditing(memory, editOwner);

  const activeResult = results[activeResultIndex];

  // Where the result on screen was read, never the editor tab's current
  // connection and database: the tab can be pointed elsewhere after the query
  // ran, and a row key read from another server's table of the same name puts
  // the wrong columns in the WHERE of an UPDATE or DELETE (#857).
  const resultSource = useResultStore((s) => s.resultSource);
  const gridConnectionId = resultSource?.connectionId ?? null;
  const gridDatabase = resultSource?.database ?? null;
  // Saving needs the source too; without it there is nowhere safe to write.
  const editBlockedReason = resultSource
    ? null
    : "Editing is unavailable: the connection this result came from is unknown. Run the query again.";

  // FR-3.1.5: a dragged column order outlives the query that produced it.
  const layout = useColumnLayout(gridConnectionId, gridDatabase, activeResult?.columns);
  const { columnOrder, orderedColumns, layoutId } = layout;

  const filters = useColumnFilters(layoutId);
  const columnFilters = filters.active;

  const { selection, clickRow, step } = useRowSelection(
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

  // New results arrived over unsaved edits, which were dropped (#865).
  const { droppedEdits } = editing;
  useEffect(() => {
    if (droppedEdits) showToast(`Discarded ${droppedEdits.count} unsaved change(s): the results changed`);
  }, [droppedEdits, showToast]);

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

  const columns = useGridColumns({ result: activeResult, maxContentLen });

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

  /**
   * Result indices in the order the rows are on screen, read when needed:
   * Tab, a copy and a Shift range all follow what the user sees, which after
   * a sort or filter is not the result's order (#839, #858).
   */
  const getScreenOrder = useCallback(() => table.getRowModel().rows.map((r) => r.index), [table]);

  const { setCellNull } = useGridShortcuts({ result: activeResult, editing, editingCell });

  const { copyAll, copyAs, exportAs } = useGridExport({
    result: activeResult,
    orderedColumns,
    selection,
    rowKey,
    getScreenOrder,
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

  // What the cells need that changes from render to render. Handed down by
  // context rather than captured in the column definitions, so the cells keep
  // their identity across a click and a double-click can land (#841).
  const cellState = useMemo<GridCellState | null>(
    () =>
      activeResult
        ? {
          result: activeResult,
          editing,
          editingCell,
          onEditCellAt: editCellAt,
          onStopEditing: stopEditing,
          onViewCell: setCellViewer,
          getScreenOrder,
          columnOrder: orderedColumns,
        }
        : null,
    [activeResult, editing, editingCell, editCellAt, stopEditing, getScreenOrder, orderedColumns],
  );

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

  /** A row click, with the on-screen order so Shift ranges follow the sort (#839). */
  const clickGridRow = useCallback((e: React.MouseEvent, dataIdx: number) => {
    clickRow(e, dataIdx, getScreenOrder());
  }, [clickRow, getScreenOrder]);

  /**
   * The grid's keyboard path (#852): arrows, Home and End move the selection
   * through the rows on screen, Shift extends it, and Ctrl+C copies the
   * selected rows as TSV — the browser's own copy took the cell text one value
   * per line. Not while typing in a cell editor or a filter.
   */
  const handleGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "c") {
      if (selection.rows.size === 0 || window.getSelection()?.toString()) return;
      e.preventDefault();
      void copyAs("tsv");
      return;
    }
    if (ctrl || e.altKey) return;
    const deltas: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: 10,
      PageUp: -10,
      Home: -Infinity,
      End: Infinity,
    };
    const delta = deltas[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const order = getScreenOrder();
    const moved = step(delta, e.shiftKey, order);
    if (moved === undefined) return;
    if (shouldVirtualize) {
      rowVirtualizer.scrollToIndex(order.indexOf(moved), { align: "auto" });
    } else {
      gridRef.current?.querySelector(`[data-row-index="${moved}"]`)?.scrollIntoView?.({ block: "nearest" });
    }
  };

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

  // Every result of a script stays reachable, whether or not the one shown
  // has a grid (#844). Not while running: the results are the last run's.
  const resultTabs = isExecuting ? null : (
    <ResultTabs
      results={results}
      activeIndex={activeResultIndex}
      onSelect={(idx) => useResultStore.getState().setActiveResult(idx)}
    />
  );

  // Running, failed, a statement that returned a count, or nothing run yet —
  // none of which is a grid.
  // A script that failed part-way still shows what the statements before the
  // failing one returned, under the error (#845).
  const errorOverResults = error !== null && results.length > 0;
  if (isExecuting || (error && !errorOverResults) || !activeResult || activeResult.columns.length === 0) {
    const placeholder = (
      <GridPlaceholder
        isExecuting={isExecuting}
        error={error}
        result={activeResult}
        startedAt={executionStartedAt}
        cancelledAfterMs={cancelledAfterMs}
        failedStatement={failedStatement}
      />
    );
    if (!resultTabs || results.length < 2) return placeholder;
    return (
      <div className="flex h-full min-h-0 flex-col">
        {resultTabs}
        <div className="min-h-0 flex-1">{placeholder}</div>
      </div>
    );
  }

  return (
    // Focusable, so it can hold focus: that scopes Ctrl+A, Ctrl+C and the
    // arrow keys to it, and puts the rows one Tab away (#852).
    <div
      ref={gridRef}
      tabIndex={0}
      aria-label="Query results"
      onKeyDown={handleGridKeyDown}
      className="flex h-full flex-col min-h-0 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand-500"
    >
      {errorOverResults && error && (
        <QueryErrorBox error={error} failedStatement={failedStatement} className="m-2 shrink-0 p-2" />
      )}

      {resultTabs}

      {/* Edit toolbar */}
      <EditToolbar
        editMode={editing.editMode}
        onToggleEditMode={editing.toggleEditMode}
        editBlockedReason={editBlockedReason}
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

      {/* Table */}
      <GridCellContext.Provider value={cellState}>
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
                  onClickRow={clickGridRow}
                  onRowContextMenu={handleRowContextMenu}
                  rowVirtualizer={rowVirtualizer}
                  rowHeight={ROW_HEIGHT}
                />
              </div>
            )
            : (
              <table
                className="border-separate border-spacing-0 text-xs"
                style={{ tableLayout: "fixed", width: "100%" }}
              >
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
                    onClickRow={clickGridRow}
                    onRowContextMenu={handleRowContextMenu}
                  />
                </tbody>
              </table>
            )}
        </div>
      </GridCellContext.Provider>

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
