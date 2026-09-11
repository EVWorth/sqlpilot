import { useCallback, useEffect } from "react";
import type { QueryResult } from "../types";
import type { useGridEditing } from "./useGridEditing";

/**
 * Keyboard shortcuts that act on a grid in edit mode.
 *
 * Split out of ResultsGrid (#406). All of them are edit-mode only, because
 * outside it there is nothing to record a change on — so the listener is not
 * even attached when the grid is read-only.
 */

export interface UseGridShortcutsOptions {
  result: QueryResult | undefined;
  editing: ReturnType<typeof useGridEditing>;
  /** Which cell is being edited, which is what Ctrl+Shift+N acts on. */
  editingCell: { rowIndex: number; colIndex: number } | null;
}

export function useGridShortcuts({ result, editing, editingCell }: UseGridShortcutsOptions) {
  /**
   * Set one cell to NULL.
   *
   * FR-3.2.3 asks for this from the context menu and from Ctrl+Shift+N. Both
   * route through here so they cannot drift (#403).
   */
  const setCellNull = useCallback((rowIdx: number, colIdx: number) => {
    if (!result || !editing.editMode) return;
    const col = result.columns[colIdx];
    if (!col) return;
    editing.editCell(rowIdx, col.name, result.rows[rowIdx]?.[colIdx] ?? null, null);
  }, [result, editing]);

  useEffect(() => {
    if (!editing.editMode) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey && e.key === "z") {
        e.preventDefault();
        editing.redo();
      } else if (e.key === "z") {
        e.preventDefault();
        editing.undo();
      } else if (e.shiftKey && e.key.toLowerCase() === "n") {
        // Compared case-insensitively: Shift is held, so the key arrives as
        // "N" on most layouts and "n" under caps lock (#403).
        if (!editingCell) return;
        e.preventDefault();
        setCellNull(editingCell.rowIndex, editingCell.colIndex);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editing.editMode, editing.undo, editing.redo, editingCell, setCellNull]);

  return { setCellNull };
}
