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

type EditAction =
  | { type: "cell"; rowIndex: number; column: string; oldValue: SqlValue; newValue: SqlValue }
  | { type: "insertRow"; index: number }
  | { type: "deleteRow"; rowIndex: number };

function reverseAction(action: EditAction): EditAction {
  switch (action.type) {
    case "cell":
      return { ...action, newValue: action.oldValue, oldValue: action.newValue };
    case "insertRow":
      return { type: "deleteRow", rowIndex: -1 }; // special flag for "remove insert"
    case "deleteRow":
      return { type: "deleteRow", rowIndex: action.rowIndex }; // toggle
  }
}

export function useGridEditing() {
  const [editMode, setEditMode] = useState(false);
  const [updates, setUpdates] = useState<Map<number, CellChange[]>>(
    () => new Map(),
  );
  const [inserts, setInserts] = useState<Record<string, SqlValue>[]>([]);
  const [deletes, setDeletes] = useState<Set<number>>(() => new Set());

  const undoStack = useRef<EditAction[]>([]);
  const redoStack = useRef<EditAction[]>([]);
  const [stackVersion, setStackVersion] = useState(0);

  const bumpVersion = () => setStackVersion((v) => v + 1);

  const pushUndo = (action: EditAction) => {
    undoStack.current.push(action);
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
      pushUndo({ type: "cell", rowIndex, column, oldValue: originalValue, newValue: newValue });
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
      setInserts((prev) => {
        const next = [...prev];
        next[insertIndex] = { ...next[insertIndex], [column]: value };
        return next;
      });
    },
    [],
  );

  const addRow = useCallback(() => {
    setInserts((prev) => {
      pushUndo({ type: "insertRow", index: prev.length });
      return [...prev, {}];
    });
  }, []);

  const deleteRow = useCallback((rowIndex: number) => {
    setDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) {
        next.delete(rowIndex);
      } else {
        next.add(rowIndex);
      }
      return next;
    });
    pushUndo({ type: "deleteRow", rowIndex });
  }, []);

  const discardAll = useCallback(() => {
    setUpdates(new Map());
    setInserts([]);
    setDeletes(new Set());
    undoStack.current = [];
    redoStack.current = [];
    bumpVersion();
  }, []);

  const applyAction = useCallback((action: EditAction): EditAction => {
    switch (action.type) {
      case "cell": {
        setUpdates((prev) => {
          const next = new Map(prev);
          const rowChanges = [...(next.get(action.rowIndex) ?? [])];
          const existing = rowChanges.findIndex((c) => c.column === action.column);
          if (existing >= 0 && action.newValue === rowChanges[existing].originalValue) {
            rowChanges.splice(existing, 1);
            if (rowChanges.length === 0) next.delete(action.rowIndex);
            else next.set(action.rowIndex, rowChanges);
          } else if (action.newValue === action.oldValue) {
            if (existing >= 0) {
              rowChanges.splice(existing, 1);
              if (rowChanges.length === 0) next.delete(action.rowIndex);
              else next.set(action.rowIndex, rowChanges);
            }
          } else {
            const change: CellChange = {
              rowIndex: action.rowIndex,
              column: action.column,
              originalValue: action.oldValue,
              newValue: action.newValue,
            };
            if (existing >= 0) rowChanges[existing] = change;
            else rowChanges.push(change);
            next.set(action.rowIndex, rowChanges);
          }
          return next;
        });
        return { ...action, newValue: action.oldValue, oldValue: action.newValue };
      }
      case "insertRow": {
        if (action.index === -1) {
          // Undo: remove last insert
          setInserts((prev: Record<string, SqlValue>[]) => {
            if (prev.length === 0) return prev;
            return prev.slice(0, -1);
          });
          return { ...action, index: -1 };
        }
        setInserts((prev) => [...prev, {}]);
        return { ...action, index: -1 };
      }
      case "deleteRow": {
        if (action.rowIndex === -1) {
          setInserts((prev) => prev.slice(0, -1));
          return { type: "insertRow", index: 0 }; // forward action for redo
        }
        setDeletes((prev: Set<number>) => {
          const next = new Set(prev);
          if (next.has(action.rowIndex)) next.delete(action.rowIndex);
          else next.add(action.rowIndex);
          return next;
        });
        return action; // toggle is its own reverse
      }
    }
  }, []);

  const undo = useCallback(() => {
    const action = undoStack.current.pop();
    if (!action) return;
    const reverse = applyAction(reverseAction(action));
    redoStack.current.push(reverse);
    bumpVersion();
  }, [applyAction]);

  const redo = useCallback(() => {
    const action = redoStack.current.pop();
    if (!action) return;
    const reverse = action.type === "insertRow"
      ? applyAction(action)
      : applyAction(reverseAction(action));
    undoStack.current.push(reverse);
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
