import { useCallback, useEffect, useState } from "react";
import { NO_SELECTION, selectAll, type Selection, selectRow } from "../lib/grid-selection";

/**
 * Which rows are picked, and the two ways of picking them.
 *
 * Split out of ResultsGrid (#406). The transitions themselves live in
 * lib/grid-selection; this is where they meet the mouse, the keyboard, and the
 * fact that a selection stops meaning anything when the rows change.
 */

export interface RowSelection {
  selection: Selection;
  /** Click a row: plain picks it, Ctrl adds, Shift extends (FR-3.3.1). */
  clickRow: (e: React.MouseEvent, rowIdx: number) => void;
  clear: () => void;
}

export function useRowSelection(
  rowCount: number,
  /** Changing it clears the selection: row 4 of the old result is not row 4 of the new one. */
  resetKey: string | null,
  /** The grid's root, so Ctrl+A only fires while the grid is what is being used. */
  gridRef: React.RefObject<HTMLElement | null>,
): RowSelection {
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);

  useEffect(() => setSelection(NO_SELECTION), [resetKey]);

  // FR-3.3.1. Scoped to the focused grid on purpose: a Ctrl+A meant for the
  // editor must not quietly select four thousand rows behind it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "a") return;
      if (!gridRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      setSelection(selectAll(rowCount));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [rowCount, gridRef]);

  const clickRow = useCallback((e: React.MouseEvent, rowIdx: number) => {
    setSelection((prev) => selectRow(prev, rowIdx, { toggle: e.ctrlKey || e.metaKey, extend: e.shiftKey }));
  }, []);

  const clear = useCallback(() => setSelection(NO_SELECTION), []);

  return { selection, clickRow, clear };
}
