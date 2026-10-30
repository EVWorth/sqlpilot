import { useCallback, useEffect, useRef, useState } from "react";
import { stepColumn } from "../lib/grid-navigation";
import type { Selection } from "../lib/grid-selection";
import type { ColumnMeta, QueryResult, SqlValue } from "../types";
import { SqlValueGuard } from "../types";
import type { useGridEditing } from "./useGridEditing";

/**
 * The grid's keyboard path: a focused cell the arrows move (#852).
 *
 * Up, Down, Page Up and Page Down move the row selection, as they did, and
 * take the focused cell with them; Shift extends the selection. Left, Right,
 * Home and End move along the row; Ctrl+Home and Ctrl+End go to the corners.
 * Enter or F2 edits the focused cell in Edit Mode. Escape clears the row
 * selection, then the focused cell. Ctrl+C copies the selected rows as TSV, or
 * the focused cell's value when no row is selected.
 *
 * The focused cell is held by result indices, like the edits and the
 * selection, so it stays on its value through a sort or a column drag.
 */

/** Result indices: the row in the result, the column in `result.columns`. */
export interface FocusedCell {
  rowIndex: number;
  colIndex: number;
}

interface GridKeyboardOptions {
  result: QueryResult | undefined;
  /** The result's columns in display order. */
  orderedColumns: readonly ColumnMeta[];
  selection: Selection;
  /** Move or extend the row selection; returns the row moved to. */
  step: (delta: number, extend: boolean, order: readonly number[]) => number | undefined;
  clearSelection: () => void;
  /** Result row indices in on-screen order. */
  getScreenOrder: () => readonly number[];
  editing: ReturnType<typeof useGridEditing>;
  editingCell: FocusedCell | null;
  onEditCellAt: (rowIndex: number, colIndex: number) => void;
  /** Copy the selected rows as TSV. */
  onCopyRows: () => void;
  onMessage: (message: string) => void;
  /** The grid's root, which holds focus while the keyboard moves the cell. */
  gridRef: React.RefObject<HTMLElement | null>;
  /** The scrolling element the rows are in. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /**
   * Set when the rows are virtualized, to their fixed height: an off-screen
   * row is not in the DOM, so where it would be is worked out from it.
   */
  virtualRowHeight: number | null;
  /** Changing it drops the focused cell: a new result has other cells. */
  resetKey: string | null;
}

export interface GridKeyboard {
  focusedCell: FocusedCell | null;
  /** The grid root's key handler. */
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  /** A click on a row: focus the cell under the pointer. */
  focusFromClick: (e: React.MouseEvent, rowIndex: number) => void;
}

const ROW_STEPS: Record<string, number> = {
  ArrowDown: 1,
  ArrowUp: -1,
  PageDown: 10,
  PageUp: -10,
};

const COLUMN_STEPS: Record<string, number> = {
  ArrowRight: 1,
  ArrowLeft: -1,
  Home: -Infinity,
  End: Infinity,
};

/** Anything inside the grid that handles its own keys: editors, menus, headers, buttons. */
const OWN_KEYS = "input, textarea, select, button, a, [contenteditable='true'], [role='dialog'], [tabindex]";

const escapeAttr = (value: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value);

export function useGridKeyboard({
  result,
  orderedColumns,
  selection,
  step,
  clearSelection,
  getScreenOrder,
  editing,
  editingCell,
  onEditCellAt,
  onCopyRows,
  onMessage,
  gridRef,
  scrollRef,
  virtualRowHeight,
  resetKey,
}: GridKeyboardOptions): GridKeyboard {
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  /** Set by a keyboard move, so the next render scrolls the cell into view. */
  const revealPending = useRef(false);

  useEffect(() => setFocusedCell(null), [resetKey]);

  // An edit started any way (double-click, Tab, Enter) moves the focus there,
  // so the arrows carry on from the cell that was just edited.
  useEffect(() => {
    if (editingCell && editingCell.rowIndex >= 0) setFocusedCell(editingCell);
  }, [editingCell]);

  // When an edit ends with Enter or Escape its input goes, and focus would
  // drop to the page. Back to the grid, so the arrows keep working. Not when
  // the user clicked somewhere else, which is where focus went.
  const wasEditing = useRef(false);
  useEffect(() => {
    const ended = wasEditing.current && editingCell === null;
    wasEditing.current = editingCell !== null;
    if (!ended) return;
    const active = document.activeElement;
    if (!active || active === document.body) gridRef.current?.focus({ preventScroll: true });
  }, [editingCell, gridRef]);

  const columnName = result && focusedCell ? result.columns[focusedCell.colIndex]?.name : undefined;

  useEffect(() => {
    if (!revealPending.current || !focusedCell || columnName === undefined) return;
    revealPending.current = false;
    const container = scrollRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    /** An element's extent in the scrolled content's coordinates. */
    const extent = (el: Element) => {
      const r = el.getBoundingClientRect();
      const top = r.top - box.top + container.scrollTop;
      const left = r.left - box.left + container.scrollLeft;
      return { top, bottom: top + r.height, left, right: left + r.width };
    };

    // Vertically, below the sticky header rather than behind it. A
    // virtualized row may not be rendered yet; rows there are a fixed height,
    // one row below the header's slot (GridRows, #847).
    let rowTop: number | undefined;
    let rowBottom: number | undefined;
    if (virtualRowHeight !== null) {
      const position = getScreenOrder().indexOf(focusedCell.rowIndex);
      if (position >= 0) {
        rowTop = virtualRowHeight * (position + 1);
        rowBottom = rowTop + virtualRowHeight;
      }
    } else {
      const cell = container.querySelector(`[data-row-index="${focusedCell.rowIndex}"]`);
      if (cell) ({ top: rowTop, bottom: rowBottom } = extent(cell));
    }
    if (rowTop !== undefined && rowBottom !== undefined) {
      const header = container.querySelector<HTMLElement>("[data-grid-header]");
      const headerHeight = header?.offsetHeight ?? 0;
      if (rowTop < container.scrollTop + headerHeight) {
        container.scrollTop = rowTop - headerHeight;
      } else if (rowBottom > container.scrollTop + container.clientHeight) {
        container.scrollTop = rowBottom - container.clientHeight;
      }
    }

    // Horizontally by the column's header, which is always rendered.
    const headerCell = container.querySelector(`[data-header-col="${escapeAttr(columnName)}"]`);
    if (headerCell) {
      const { left, right } = extent(headerCell);
      if (left < container.scrollLeft) {
        container.scrollLeft = left;
      } else if (right > container.scrollLeft + container.clientWidth) {
        container.scrollLeft = right - container.clientWidth;
      }
    }
  }, [focusedCell, columnName, scrollRef, virtualRowHeight, getScreenOrder]);

  const moveTo = useCallback((cell: FocusedCell) => {
    revealPending.current = true;
    setFocusedCell(cell);
  }, []);

  /** Where the focused cell's column sits on screen, or null. */
  const columnPosition = useCallback((): number | null => {
    if (!result || !focusedCell) return null;
    const name = result.columns[focusedCell.colIndex]?.name;
    const position = orderedColumns.findIndex((c) => c.name === name);
    return position < 0 ? null : position;
  }, [result, focusedCell, orderedColumns]);

  /** The result index of the column at a screen position. */
  const resultColumn = useCallback(
    (position: number | null): number | undefined => {
      if (!result || position === null) return undefined;
      const name = orderedColumns[position]?.name;
      const index = result.columns.findIndex((c) => c.name === name);
      return index < 0 ? undefined : index;
    },
    [result, orderedColumns],
  );

  const copyCell = useCallback((cell: FocusedCell) => {
    if (!result) return;
    const column = result.columns[cell.colIndex];
    const original = result.rows[cell.rowIndex]?.[cell.colIndex];
    if (!column || original === undefined) return;
    const value: SqlValue = editing.editMode
      ? editing.getCellValue(cell.rowIndex, column.name, original)
      : original;
    void navigator.clipboard.writeText(SqlValueGuard.toString(value)).then(
      () => onMessage(`Copied ${column.name}`),
      (e: unknown) => onMessage(`Copy failed: ${String(e)}`),
    );
  }, [result, editing, onMessage]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const owner = target.closest(OWN_KEYS);
    if (owner && owner !== e.currentTarget) return;
    if (!result) return;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === "c") {
      if (window.getSelection()?.toString()) return;
      if (selection.rows.size > 0) {
        e.preventDefault();
        onCopyRows();
      } else if (focusedCell) {
        e.preventDefault();
        copyCell(focusedCell);
      }
      return;
    }
    if (e.altKey) return;

    if (ctrl && (e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      const toEnd = e.key === "End";
      const order = getScreenOrder();
      const row = step(toEnd ? Infinity : -Infinity, e.shiftKey, order);
      const col = resultColumn(stepColumn(null, toEnd ? Infinity : -Infinity, orderedColumns.length));
      if (row !== undefined && col !== undefined) moveTo({ rowIndex: row, colIndex: col });
      return;
    }
    if (ctrl) return;

    const rowDelta = ROW_STEPS[e.key];
    if (rowDelta !== undefined) {
      e.preventDefault();
      const row = step(rowDelta, e.shiftKey, getScreenOrder());
      const col = focusedCell?.colIndex ?? resultColumn(stepColumn(null, 1, orderedColumns.length));
      if (row !== undefined && col !== undefined) moveTo({ rowIndex: row, colIndex: col });
      return;
    }

    const colDelta = COLUMN_STEPS[e.key];
    if (colDelta !== undefined) {
      e.preventDefault();
      const row = focusedCell?.rowIndex ?? selection.cursor ?? selection.anchor ?? getScreenOrder()[0];
      const col = resultColumn(stepColumn(columnPosition(), colDelta, orderedColumns.length));
      if (row !== undefined && row !== null && col !== undefined) moveTo({ rowIndex: row, colIndex: col });
      return;
    }

    if ((e.key === "Enter" || e.key === "F2") && focusedCell && editing.editMode) {
      e.preventDefault();
      onEditCellAt(focusedCell.rowIndex, focusedCell.colIndex);
      return;
    }

    if (e.key === "Escape") {
      if (selection.rows.size > 0) {
        e.preventDefault();
        clearSelection();
      } else if (focusedCell) {
        e.preventDefault();
        setFocusedCell(null);
      }
    }
  }, [
    result,
    selection,
    focusedCell,
    onCopyRows,
    copyCell,
    getScreenOrder,
    step,
    resultColumn,
    orderedColumns.length,
    moveTo,
    columnPosition,
    editing.editMode,
    onEditCellAt,
    clearSelection,
  ]);

  const focusFromClick = useCallback((e: React.MouseEvent, rowIndex: number) => {
    if (!result) return;
    const name = (e.target as HTMLElement).closest("[data-col]")?.getAttribute("data-col");
    const clicked = name ? result.columns.findIndex((c) => c.name === name) : -1;
    setFocusedCell((prev) => {
      const colIndex = clicked >= 0 ? clicked : prev?.colIndex ?? resultColumn(0);
      return colIndex === undefined ? prev : { rowIndex, colIndex };
    });
  }, [result, resultColumn]);

  return { focusedCell, onKeyDown, focusFromClick };
}
