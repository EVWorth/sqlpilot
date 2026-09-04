import { useCallback, useMemo, useRef, useState } from "react";
import type { SqlValue } from "../types";

export interface CellChange {
  rowIndex: number;
  column: string;
  originalValue: SqlValue;
  newValue: SqlValue;
}

export interface PendingChanges {
  updates: Map<number, CellChange[]>;
  inserts: Record<string, SqlValue>[];
  deletes: Set<number>;
}

/**
 * A mutation that can be applied as-is.
 *
 * Every action states the resulting value rather than describing a change, so
 * applying one is the same operation whether it came from the user, from undo
 * or from redo. The previous model derived the inverse on the fly and used
 * `index: -1` to mean "the last insert", which lost the position an insert had
 * and made redo re-derive an inverse it had already applied (#404).
 */
type EditAction =
  | {
    type: "setCell";
    rowIndex: number;
    column: string;
    originalValue: SqlValue;
    value: SqlValue;
  }
  | { type: "addInsertRow"; index: number; row: Record<string, SqlValue> }
  | { type: "removeInsertRow"; index: number }
  | { type: "setInsertCell"; index: number; column: string; value: SqlValue | undefined }
  | { type: "setDeleted"; rowIndex: number; deleted: boolean };

/**
 * One step of history: what to do to undo it, and what to do to put it back.
 *
 * Held as a pair at push time, while both states are known, rather than
 * computed later from an action alone.
 */
interface HistoryEntry {
  undo: EditAction;
  redo: EditAction;
}

export function useGridEditing() {
  const [editMode, setEditMode] = useState(false);
  const [updates, setUpdates] = useState<Map<number, CellChange[]>>(
    () => new Map(),
  );
  const [inserts, setInserts] = useState<Record<string, SqlValue>[]>([]);
  const [deletes, setDeletes] = useState<Set<number>>(() => new Set());

  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const [stackVersion, setStackVersion] = useState(0);

  const bumpVersion = () => setStackVersion((v) => v + 1);

  const pushUndo = (entry: HistoryEntry) => {
    undoStack.current.push(entry);
    redoStack.current = [];
    bumpVersion();
  };

  const editCell = useCallback(
    (rowIndex: number, column: string, originalValue: SqlValue, newValue: SqlValue) => {
      setUpdates((prev) => {
        const next = new Map(prev);
        const rowChanges = [...(next.get(rowIndex) ?? [])];
        const existing = rowChanges.findIndex((c) => c.column === column);

        if (newValue === originalValue) {
          // Value reverted to original — remove the change
          if (existing >= 0) rowChanges.splice(existing, 1);
          if (rowChanges.length === 0) {
            next.delete(rowIndex);
          } else {
            next.set(rowIndex, rowChanges);
          }
          return next;
        }

        const change: CellChange = { rowIndex, column, originalValue, newValue };
        if (existing >= 0) {
          rowChanges[existing] = change;
        } else {
          rowChanges.push(change);
        }
        next.set(rowIndex, rowChanges);
        return next;
      });
      pushUndo({
        undo: { type: "setCell", rowIndex, column, originalValue, value: originalValue },
        redo: { type: "setCell", rowIndex, column, originalValue, value: newValue },
      });
    },
    [],
  );

  const revertCell = useCallback((rowIndex: number, column: string) => {
    setUpdates((prev) => {
      const next = new Map(prev);
      const rowChanges = (next.get(rowIndex) ?? []).filter(
        (c) => c.column !== column,
      );
      if (rowChanges.length === 0) {
        next.delete(rowIndex);
      } else {
        next.set(rowIndex, rowChanges);
      }
      return next;
    });
  }, []);

  const editInsertCell = useCallback(
    (insertIndex: number, column: string, value: SqlValue) => {
      // The previous value, so this edit can be undone on its own. It pushed
      // nothing before, so the cell showed as dirty and Undo did nothing to it
      // — the only way back was undoing the whole added row (#405).
      const previous = inserts[insertIndex]?.[column];
      setInserts((prev) => {
        const next = [...prev];
        next[insertIndex] = { ...next[insertIndex], [column]: value };
        return next;
      });
      pushUndo({
        undo: { type: "setInsertCell", index: insertIndex, column, value: previous },
        redo: { type: "setInsertCell", index: insertIndex, column, value },
      });
    },
    [inserts],
  );

  const addRow = useCallback(() => {
    // The position is recorded, so undo removes this row rather than whichever
    // happens to be last, and redo puts it back where it was (#404).
    const index = inserts.length;
    setInserts((prev) => [...prev, {}]);
    pushUndo({
      undo: { type: "removeInsertRow", index },
      redo: { type: "addInsertRow", index, row: {} },
    });
  }, [inserts]);

  const deleteRow = useCallback((rowIndex: number) => {
    const wasDeleted = deletes.has(rowIndex);
    setDeletes((prev) => {
      const next = new Set(prev);
      if (wasDeleted) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
    // Both directions state the resulting flag. The old entry was the same
    // toggle in both directions, so redo undid the undo (#404).
    pushUndo({
      undo: { type: "setDeleted", rowIndex, deleted: wasDeleted },
      redo: { type: "setDeleted", rowIndex, deleted: !wasDeleted },
    });
  }, [deletes]);

  const discardAll = useCallback(() => {
    setUpdates(new Map());
    setInserts([]);
    setDeletes(new Set());
    undoStack.current = [];
    redoStack.current = [];
    bumpVersion();
  }, []);

  /** Apply one action. Actions state the outcome, so this never inverts. */
  const applyAction = useCallback((action: EditAction) => {
    switch (action.type) {
      case "setCell": {
        setUpdates((prev) => {
          const next = new Map(prev);
          const rowChanges = [...(next.get(action.rowIndex) ?? [])];
          const existing = rowChanges.findIndex((c) => c.column === action.column);
          // Back at the stored value means there is no longer a change here.
          if (action.value === action.originalValue) {
            if (existing >= 0) rowChanges.splice(existing, 1);
          } else {
            const change: CellChange = {
              rowIndex: action.rowIndex,
              column: action.column,
              originalValue: action.originalValue,
              newValue: action.value,
            };
            if (existing >= 0) rowChanges[existing] = change;
            else rowChanges.push(change);
          }
          if (rowChanges.length === 0) next.delete(action.rowIndex);
          else next.set(action.rowIndex, rowChanges);
          return next;
        });
        return;
      }
      case "addInsertRow": {
        setInserts((prev) => {
          const next = [...prev];
          next.splice(action.index, 0, { ...action.row });
          return next;
        });
        return;
      }
      case "removeInsertRow": {
        setInserts((prev) => {
          const next = [...prev];
          next.splice(action.index, 1);
          return next;
        });
        return;
      }
      case "setInsertCell": {
        setInserts((prev) => {
          const next = [...prev];
          const row = { ...next[action.index] };
          if (action.value === undefined) delete row[action.column];
          else row[action.column] = action.value;
          next[action.index] = row;
          return next;
        });
        return;
      }
      case "setDeleted": {
        // Stating the resulting state rather than toggling: a toggle applied
        // twice is a no-op, which is what made redo of a delete do nothing.
        setDeletes((prev) => {
          const next = new Set(prev);
          if (action.deleted) next.add(action.rowIndex);
          else next.delete(action.rowIndex);
          return next;
        });
        return;
      }
    }
  }, []);

  const undo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    applyAction(entry.undo);
    redoStack.current.push(entry);
    bumpVersion();
  }, [applyAction]);

  const redo = useCallback(() => {
    const entry = redoStack.current.pop();
    if (!entry) return;
    applyAction(entry.redo);
    undoStack.current.push(entry);
    bumpVersion();
  }, [applyAction]);

  const canUndo = useMemo(() => undoStack.current.length > 0, [stackVersion]);
  const canRedo = useMemo(() => redoStack.current.length > 0, [stackVersion]);

  const toggleEditMode = useCallback(() => {
    setEditMode((prev) => {
      if (prev) {
        // Exiting edit mode — discard changes
        setUpdates(new Map());
        setInserts([]);
        setDeletes(new Set());
        undoStack.current = [];
        redoStack.current = [];
      }
      return !prev;
    });
  }, []);

  const getPendingCount = useMemo(() => {
    return updates.size + inserts.length + deletes.size;
  }, [updates, inserts, deletes]);

  const hasChanges = getPendingCount > 0;

  const getCellValue = useCallback(
    (rowIndex: number, column: string, originalValue: SqlValue): SqlValue => {
      const rowChanges = updates.get(rowIndex);
      if (!rowChanges) return originalValue;
      const change = rowChanges.find((c) => c.column === column);
      return change ? change.newValue : originalValue;
    },
    [updates],
  );

  const isCellEdited = useCallback(
    (rowIndex: number, column: string): boolean => {
      const rowChanges = updates.get(rowIndex);
      if (!rowChanges) return false;
      return rowChanges.some((c) => c.column === column);
    },
    [updates],
  );

  const isRowEdited = useCallback(
    (rowIndex: number): boolean => updates.has(rowIndex),
    [updates],
  );

  const isRowDeleted = useCallback(
    (rowIndex: number): boolean => deletes.has(rowIndex),
    [deletes],
  );

  return {
    editMode,
    toggleEditMode,
    updates,
    inserts,
    deletes,
    editCell,
    revertCell,
    editInsertCell,
    addRow,
    deleteRow,
    discardAll,
    undo,
    redo,
    canUndo,
    canRedo,
    pendingCount: getPendingCount,
    hasChanges,
    getCellValue,
    isCellEdited,
    isRowEdited,
    isRowDeleted,
  };
}
