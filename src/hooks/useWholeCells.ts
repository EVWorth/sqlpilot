import { useCallback, useMemo, useState } from "react";
import type { RowSource } from "../lib/row-source";
import type { SqlValue } from "../types";

/**
 * Whole values of cells the row source painted cut short, fetched for editing.
 *
 * An edit starts from the value as stored, and records it as the original, so
 * a cell that arrived as its first bytes cannot be edited as it is. The cell
 * asks for its whole value when the edit starts (`load`) and reads it here
 * once it has arrived (`get`). Kept per source: another result's cells are
 * other cells.
 */
export interface WholeCells {
  /** The whole value, once loaded. Wrapped, so a loaded NULL is not "not loaded". */
  get: (rowIndex: number, colIndex: number) => { value: SqlValue } | undefined;
  load: (rowIndex: number, colIndex: number) => void;
}

const keyOf = (rowIndex: number, colIndex: number) => `${rowIndex}:${colIndex}`;

export function useWholeCells(
  source: RowSource,
  /** The value could not be fetched, so the edit cannot start. */
  onError: (rowIndex: number, colIndex: number, error: unknown) => void,
): WholeCells {
  const [loaded, setLoaded] = useState<{ source: RowSource; values: ReadonlyMap<string, SqlValue> }>(
    () => ({ source, values: new Map() }),
  );
  const values = loaded.source === source ? loaded.values : undefined;
  const pending = useMemo(() => ({ source, keys: new Set<string>() }), [source]);

  const load = useCallback((rowIndex: number, colIndex: number) => {
    const key = keyOf(rowIndex, colIndex);
    if (pending.keys.has(key)) return;
    pending.keys.add(key);
    source.cell(rowIndex, colIndex).then(
      (value) =>
        setLoaded((prev) => {
          const kept = prev.source === source ? prev.values : [];
          return { source, values: new Map(kept).set(key, value) };
        }),
      (e: unknown) => onError(rowIndex, colIndex, e),
    ).finally(() => pending.keys.delete(key));
  }, [source, pending, onError]);

  const get = useCallback((rowIndex: number, colIndex: number) => {
    const key = keyOf(rowIndex, colIndex);
    const value = values?.get(key);
    return value === undefined ? undefined : { value };
  }, [values]);

  return useMemo(() => ({ get, load }), [get, load]);
}
