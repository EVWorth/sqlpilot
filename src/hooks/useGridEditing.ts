import { useState, useCallback, useMemo } from "react";

export interface CellChange {
  rowIndex: number;
  column: string;
  originalValue: unknown;
  newValue: unknown;
}

export interface PendingChanges {
  updates: Map<number, CellChange[]>;
  inserts: Record<string, unknown>[];
  deletes: Set<number>;
}

export function useGridEditing() {
  const [editMode, setEditMode] = useState(false);
  const [updates, setUpdates] = useState<Map<number, CellChange[]>>(
    () => new Map(),
  );
  const [inserts, setInserts] = useState<Record<string, unknown>[]>([]);
  const [deletes, setDeletes] = useState<Set<number>>(() => new Set());

  const editCell = useCallback(
    (rowIndex: number, column: string, originalValue: unknown, newValue: unknown) => {
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
    (insertIndex: number, column: string, value: unknown) => {
      setInserts((prev) => {
        const next = [...prev];
        next[insertIndex] = { ...next[insertIndex], [column]: value };
        return next;
      });
    },
    [],
  );

  const addRow = useCallback(() => {
    setInserts((prev) => [...prev, {}]);
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
  }, []);

  const discardAll = useCallback(() => {
    setUpdates(new Map());
    setInserts([]);
    setDeletes(new Set());
  }, []);

  const toggleEditMode = useCallback(() => {
    setEditMode((prev) => {
      if (prev) {
        // Exiting edit mode — discard changes
        setUpdates(new Map());
        setInserts([]);
        setDeletes(new Set());
      }
      return !prev;
    });
  }, []);

  const getPendingCount = useMemo(() => {
    return updates.size + inserts.length + deletes.size;
  }, [updates, inserts, deletes]);

  const hasChanges = getPendingCount > 0;

  const getCellValue = useCallback(
    (rowIndex: number, column: string, originalValue: unknown): unknown => {
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
    pendingCount: getPendingCount,
    hasChanges,
    getCellValue,
    isCellEdited,
    isRowEdited,
    isRowDeleted,
  };
}
