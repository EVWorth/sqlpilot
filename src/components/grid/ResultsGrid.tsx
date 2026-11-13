import { useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useColumnFilters } from "../../hooks/useColumnFilters";
import { useColumnLayout } from "../../hooks/useColumnLayout";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useGridColumns } from "../../hooks/useGridColumns";
import { useGridContextMenu } from "../../hooks/useGridContextMenu";
import { useGridEditing } from "../../hooks/useGridEditing";
import { useGridExport } from "../../hooks/useGridExport";
import { useGridKeyboard } from "../../hooks/useGridKeyboard";
import { useGridSave } from "../../hooks/useGridSave";
import { useGridShortcuts } from "../../hooks/useGridShortcuts";
import { useRowCount } from "../../hooks/useRowCount";
import { useRowKey } from "../../hooks/useRowKey";
import { useRowSelection } from "../../hooks/useRowSelection";
import { measureContent, useContentWidths, useRowSource } from "../../hooks/useRowSource";
import { useWholeCells } from "../../hooks/useWholeCells";
import { gridFeatures } from "../../lib/grid-features";
import { recallGrid, useKeepGridOnUnmount } from "../../lib/grid-memory";
import { type GridSort, toggleSort } from "../../lib/grid-sort";
import { columnTypesOf } from "../../lib/sql-generator";
import { isNumericSqlType } from "../../lib/sql-types";
import { useResultStore } from "../../stores/resultStore";
import { CellViewerModal } from "./CellViewerModal";
import { EditToolbar } from "./EditToolbar";
import { GridBanners } from "./GridBanners";
import { GridCellContext, type GridCellState } from "./GridCell";
import { GridFooter } from "./GridFooter";
import { GridHeaderRow } from "./GridHeaderRow";
import { GridPlaceholder, QueryErrorBox } from "./GridPlaceholder";
import { TableGridRows, VirtualGridRows } from "./GridRows";
import { ResultTabs } from "./ResultTabs";

/** TanStack is given the columns only; this is its (stable) row list. */
const NO_ROWS: Record<string, unknown>[] = [];

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
  const [sorting, setSorting] = useState<GridSort>(() => recallGrid(memory, "sorting") ?? []);
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

  // The rows. Everything below reads them through the source, which sorts and
  // filters them and may not hold them all (docs/design/RESULT_STORE.md).
  const { source, view } = useRowSource(activeResult, sorting, columnFilters);
  const { viewCount } = view;

  const { selection, clickRow, step, clear: clearSelection } = useRowSelection(source, layoutId, gridRef);

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

  // From a sample of the rows the source has, so sizing the columns can
  // never make it load the whole result.
  const maxContentLen = useContentWidths(source, view.revision);

  const columns = useGridColumns({ result: activeResult, maxContentLen });

  // TanStack keeps the columns: widths, resizing and order. It is given no
  // rows; those are the source's.
  const table = useTable({
    features: gridFeatures,
    data: NO_ROWS,
    columns,
    state: { columnSizing, columnOrder },
    onColumnSizingChange: setColumnSizing,
    onColumnOrderChange: layout.setColumnOrder,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
  });
  const headers = table.getFlatHeaders();
  const columnSizes: Record<string, number> = {};
  for (const header of headers) columnSizes[header.column.id] = header.getSize();

  // FR-3.1.2: ASC then DESC, for every column type, and Shift adds a sort key
  // rather than replacing one, so "department, then hire_date" is expressible
  // (#392).
  const sortColumn = useCallback((columnId: string, multi: boolean) => {
    setSorting((prev) => toggleSort(prev, columnId, multi));
  }, []);

  const { setCellNull } = useGridShortcuts({
    result: activeResult,
    source,
    editing,
    editingCell,
    onMessage: showToast,
  });

  const { copyAll, copyAs, exportAs } = useGridExport({
    result: activeResult,
    source,
    orderedColumns,
    selection,
    rowKey,
    onMessage: showToast,
  });

  const handleRowContextMenu = useGridContextMenu({
    result: activeResult,
    source,
    orderedColumns,
    selection,
    editing,
    showContextMenu,
    onCopyAs: copyAs,
    onSetNull: setCellNull,
  });

  const { isSaving, save } = useGridSave({
    result: activeResult,
    source,
    editing,
    rowKey,
    keyWarning,
    columnTypes,
    onMessage: showToast,
  });

  // A cell cut short is edited from its whole value, fetched when the edit
  // starts. If it cannot be had, neither can the edit.
  const wholeCellFailed = useCallback((_row: number, colIndex: number, e: unknown) => {
    showToast(`Could not load ${source.columns[colIndex]?.name ?? "the value"}: ${String(e)}`);
    stopEditing();
  }, [source, showToast, stopEditing]);
  const wholeCells = useWholeCells(source, wholeCellFailed);

  // What the cells need that changes from render to render. Handed down by
  // context rather than captured in the column definitions, so the cells keep
  // their identity across a click and a double-click can land (#841).
  const cellState = useMemo<GridCellState | null>(
    () =>
      activeResult
        ? {
          result: activeResult,
          source,
          editing,
          editingCell,
          onEditCellAt: editCellAt,
          onStopEditing: stopEditing,
          onViewCell: setCellViewer,
          columnOrder: orderedColumns,
          wholeCell: wholeCells.get,
          onLoadWholeCell: wholeCells.load,
          onMessage: showToast,
        }
        : null,
    [activeResult, source, editing, editingCell, editCellAt, stopEditing, orderedColumns, wholeCells, showToast],
  );

  /**
   * Widen a column to fit its widest value, capped so one JSON blob cannot own
   * the grid. Judged from the rows the source has at the top of the view, as
   * the initial widths are, rather than from every row.
   */
  const autoSizeColumn = useCallback((colName: string) => {
    const maxLen = measureContent(source)[colName] ?? colName.length;
    table.setColumnSizing((prev) => ({
      ...prev,
      [colName]: Math.max(80, Math.min(600, Math.min(maxLen, 50) * 9 + 40)),
    }));
  }, [source, table]);

  // Row virtualization: only render visible rows to avoid DOM bloat
  const ROW_HEIGHT = 32; // px per row
  const insertCount = editing.editMode ? editing.inserts.length : 0;
  const totalRows = viewCount + insertCount;
  // By the result's size, not the view's: a filter that narrows a large
  // result must not swap the layout, and the header with the open filter
  // menu in it, from under the user.
  const shouldVirtualize = source.rowCount + insertCount > 5000;

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    enabled: shouldVirtualize,
    overscan: 5,
  });

  // Tell the source which rows are on screen, so one that loads on demand
  // loads those. The table layout draws every row of the view.
  const virtualItems = shouldVirtualize ? rowVirtualizer.getVirtualItems() : null;
  const visibleStart = virtualItems ? virtualItems[0]?.index ?? 0 : 0;
  const visibleEnd = virtualItems
    ? Math.min(viewCount, (virtualItems[virtualItems.length - 1]?.index ?? -1) + 1)
    : viewCount;
  useEffect(() => {
    source.setVisibleRange(visibleStart, Math.max(visibleStart, visibleEnd));
  }, [source, visibleStart, visibleEnd, view.revision]);

  const keyboard = useGridKeyboard({
    result: activeResult,
    source,
    orderedColumns,
    selection,
    step,
    clearSelection,
    editing,
    editingCell,
    onEditCellAt: editCellAt,
    onCopyRows: () => void copyAs("tsv"),
    onMessage: showToast,
    gridRef,
    scrollRef: scrollContainerRef,
    virtualRowHeight: shouldVirtualize ? ROW_HEIGHT : null,
    resetKey: layoutId,
  });
  const { focusFromClick } = keyboard;
  const focusedCell = keyboard.focusedCell && activeResult
    ? {
      rowIndex: keyboard.focusedCell.rowIndex,
      columnName: activeResult.columns[keyboard.focusedCell.colIndex]?.name ?? "",
    }
    : null;

  /**
   * A row click. A Shift range follows the rows as they are on screen (#839).
   * It also focuses the cell clicked, for the arrow keys (#852).
   */
  const clickGridRow = useCallback((e: React.MouseEvent, dataIdx: number) => {
    clickRow(e, dataIdx);
    focusFromClick(e, dataIdx);
  }, [clickRow, focusFromClick]);

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
      onKeyDown={keyboard.onKeyDown}
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
        rowsShown={source.rowCount}
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
                <div data-grid-header className="sticky top-0 z-10 flex bg-[var(--color-bg-tertiary)] text-xs">
                  <div
                    className="flex items-center justify-center border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-center font-normal text-[var(--color-text-muted)]"
                    style={{ flex: "0 0 48px" }}
                  >
                    #
                  </div>
                  <GridHeaderRow
                    headers={headers}
                    as="div"
                    sort={sorting}
                    onSort={sortColumn}
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
                  source={source}
                  viewCount={viewCount}
                  columnSizes={columnSizes}
                  editing={editing}
                  editingCell={editingCell}
                  selection={selection}
                  focusedCell={focusedCell}
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
                <thead data-grid-header className="sticky top-0 z-10 bg-[var(--color-bg-tertiary)]">
                  <tr>
                    <th className="w-12 border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-center font-normal text-[var(--color-text-muted)]">
                      #
                    </th>
                    <GridHeaderRow
                      headers={headers}
                      as="th"
                      sort={sorting}
                      onSort={sortColumn}
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
                    source={source}
                    viewCount={viewCount}
                    columnSizes={columnSizes}
                    editing={editing}
                    editingCell={editingCell}
                    selection={selection}
                    focusedCell={focusedCell}
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
        rowsShown={source.rowCount}
        rowsAfterFilter={viewCount}
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
