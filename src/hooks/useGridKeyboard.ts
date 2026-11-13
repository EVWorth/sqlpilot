import { useCallback, useEffect, useRef, useState } from "react";
import { stepColumn } from "../lib/grid-navigation";
import type { Selection } from "../lib/grid-selection";
import type { ResultMeta, RowSource } from "../lib/row-source";
import type { ColumnMeta, SqlValue } from "../types";
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
  result: ResultMeta | undefined;
  /** The rows: where one is on screen, and a cell's value for Ctrl+C. */
  source: RowSource;
  /** The result's columns in display order. */
  orderedColumns: readonly ColumnMeta[];
  selection: Selection;
  /** Move or extend the row selection; resolves to the row moved to. */
  step: (delta: number, extend: boolean) => Promise<number | undefined>;
  clearSelection: () => void;
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
  source,
  orderedColumns,
  selection,
  step,
  clearSelection,
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
  const [focusedCell, setFocusedState] = useState<FocusedCell | null>(null);
  // The focused cell as of the last change, readable between renders: a row
  // step waits for the source, and the key after it must carry on from where
  // that step landed rather than from the last render.
  const focused = useRef<FocusedCell | null>(null);
  const setFocusedCell = useCallback(
    (next: FocusedCell | null | ((prev: FocusedCell | null) => FocusedCell | null)) => {
      focused.current = typeof next === "function" ? next(focused.current) : next;
      setFocusedState(focused.current);
    },
    [],
  );
  /** Set by a keyboard move, so the next render scrolls the cell into view. */
  const revealPending = useRef(false);

  useEffect(() => setFocusedCell(null), [resetKey, setFocusedCell]);

  // An edit started any way (double-click, Tab, Enter) moves the focus there,
  // so the arrows carry on from the cell that was just edited.
  useEffect(() => {
    if (editingCell && editingCell.rowIndex >= 0) setFocusedCell(editingCell);
  }, [editingCell, setFocusedCell]);

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

    // Vertically, below the sticky header rather than behind it.
    const revealRow = (rowTop: number, rowBottom: number) => {
      const header = container.querySelector<HTMLElement>("[data-grid-header]");
      const headerHeight = header?.offsetHeight ?? 0;
      if (rowTop < container.scrollTop + headerHeight) {
        container.scrollTop = rowTop - headerHeight;
      } else if (rowBottom > container.scrollTop + container.clientHeight) {
        container.scrollTop = rowBottom - container.clientHeight;
      }
    };
    let cancelled = false;
    if (virtualRowHeight !== null) {
      // A virtualized row may not be rendered yet; rows there are a fixed
      // height, one row below the header's slot (GridRows, #847), so where
      // it is follows from its position in the view, which the source knows.
      const rowHeight = virtualRowHeight;
      void source.positionOf(focusedCell.rowIndex).then((position) => {
        if (cancelled || position === null) return;
        revealRow(rowHeight * (position + 1), rowHeight * (position + 2));
      }, () => {});
    } else {
      const cell = container.querySelector(`[data-row-index="${focusedCell.rowIndex}"]`);
      if (cell) {
        const { top, bottom } = extent(cell);
        revealRow(top, bottom);
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
    return () => {
      cancelled = true;
    };
  }, [focusedCell, columnName, scrollRef, virtualRowHeight, source]);

  const moveTo = useCallback((cell: FocusedCell) => {
    revealPending.current = true;
    setFocusedCell(cell);
  }, [setFocusedCell]);

  /** Step the row selection, then put the focused cell on the row it reached. */
  const moveRow = useCallback((delta: number, extend: boolean, column: () => number | undefined) => {
    void step(delta, extend).then((row) => {
      const col = column();
      if (row !== undefined && col !== undefined) moveTo({ rowIndex: row, colIndex: col });
    }, () => {});
  }, [step, moveTo]);

  /** Where the focused cell's column sits on screen, or null. */
  const columnPosition = useCallback((): number | null => {
    const cell = focused.current;
    if (!result || !cell) return null;
    const name = result.columns[cell.colIndex]?.name;
    const position = orderedColumns.findIndex((c) => c.name === name);
    return position < 0 ? null : position;
  }, [result, orderedColumns]);

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
    if (!column || cell.rowIndex < 0 || cell.rowIndex >= source.rowCount) return;
    // The whole value: what the grid painted may be cut short.
    void source.cell(cell.rowIndex, cell.colIndex).then((original) => {
      const value: SqlValue = editing.editMode
        ? editing.getCellValue(cell.rowIndex, column.name, original)
        : original;
      return navigator.clipboard.writeText(SqlValueGuard.toString(value));
    }).then(
      () => onMessage(`Copied ${column.name}`),
      (e: unknown) => onMessage(`Copy failed: ${String(e)}`),
    );
  }, [result, source, editing, onMessage]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const owner = target.closest(OWN_KEYS);
    if (owner && owner !== e.currentTarget) return;
    if (!result) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const at = focused.current;

    if (ctrl && e.key.toLowerCase() === "c") {
      if (window.getSelection()?.toString()) return;
      if (selection.rows.size > 0) {
        e.preventDefault();
        onCopyRows();
      } else if (at) {
        e.preventDefault();
        copyCell(at);
      }
      return;
    }
    if (e.altKey) return;

    if (ctrl && (e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      const toEnd = e.key === "End";
      const col = resultColumn(stepColumn(null, toEnd ? Infinity : -Infinity, orderedColumns.length));
      moveRow(toEnd ? Infinity : -Infinity, e.shiftKey, () => col);
      return;
    }
    if (ctrl) return;

    const rowDelta = ROW_STEPS[e.key];
    if (rowDelta !== undefined) {
      e.preventDefault();
      // The column is read when the step lands: Left or Right pressed while
      // it waited has already moved it.
      moveRow(
        rowDelta,
        e.shiftKey,
        () => focused.current?.colIndex ?? resultColumn(stepColumn(null, 1, orderedColumns.length)),
      );
      return;
    }

    const colDelta = COLUMN_STEPS[e.key];
    if (colDelta !== undefined) {
      e.preventDefault();
      const col = resultColumn(stepColumn(columnPosition(), colDelta, orderedColumns.length));
      if (col === undefined) return;
      const row = at?.rowIndex ?? selection.cursor ?? selection.anchor;
      if (row !== undefined && row !== null) {
        moveTo({ rowIndex: row, colIndex: col });
        return;
      }
      // Nothing focused or selected yet: the row at the top of the view.
      void source.indicesAt(0, 1).then(([top]) => {
        if (top !== undefined && focused.current === null) moveTo({ rowIndex: top, colIndex: col });
      }, () => {});
      return;
    }

    if ((e.key === "Enter" || e.key === "F2") && at && editing.editMode) {
      e.preventDefault();
      onEditCellAt(at.rowIndex, at.colIndex);
      return;
    }

    if (e.key === "Escape") {
      if (selection.rows.size > 0) {
        e.preventDefault();
        clearSelection();
      } else if (at) {
        e.preventDefault();
        setFocusedCell(null);
      }
    }
  }, [
    result,
    source,
    selection,
    onCopyRows,
    copyCell,
    moveRow,
    resultColumn,
    orderedColumns.length,
    moveTo,
    columnPosition,
    editing.editMode,
    onEditCellAt,
    clearSelection,
    setFocusedCell,
  ]);

  const focusFromClick = useCallback((e: React.MouseEvent, rowIndex: number) => {
    if (!result) return;
    const name = (e.target as HTMLElement).closest("[data-col]")?.getAttribute("data-col");
    const clicked = name ? result.columns.findIndex((c) => c.name === name) : -1;
    setFocusedCell((prev) => {
      const colIndex = clicked >= 0 ? clicked : prev?.colIndex ?? resultColumn(0);
      return colIndex === undefined ? prev : { rowIndex, colIndex };
    });
  }, [result, resultColumn, setFocusedCell]);

  return { focusedCell, onKeyDown, focusFromClick };
}
