import type { ColumnMeta, ResultFilter, SortKey } from "./bindings";
import type { ColumnFilter } from "./grid-filter";

/**
 * The grid's sort, as its headers hold it: by column name, so it outlives a
 * re-run of the query, and in key order.
 *
 * The row source takes the same thing by column position (`SortKey`); the
 * translation is here, next to the rule for what a header click does.
 */
export interface GridSortKey {
  /** The column's name. */
  id: string;
  desc: boolean;
}

export type GridSort = GridSortKey[];

/**
 * What clicking a column's header does to the sort (FR-3.1.2).
 *
 * A plain click sorts by that column alone: ascending, then descending, then
 * not at all. With `multi` (Shift) the column is added as a further key, or
 * cycles in place, so "department, then hire_date" is expressible (#392).
 * Ascending always comes first, for numbers as for text.
 */
export function toggleSort(sort: GridSort, id: string, multi: boolean): GridSort {
  const at = sort.findIndex((k) => k.id === id);
  const existing = at >= 0 ? sort[at] : undefined;
  // Unsorted -> ascending -> descending -> unsorted.
  const next: "asc" | "desc" | null = !existing ? "asc" : existing.desc ? null : "desc";
  const key: GridSortKey = { id, desc: next === "desc" };

  if (multi && sort.length > 0) {
    if (!existing) return [...sort, key];
    if (next === null) return sort.filter((k) => k.id !== id);
    return sort.map((k) => (k.id === id ? key : k));
  }
  return existing && next === null ? [] : [key];
}

/** The sort by column position, dropping keys for columns the result lacks. */
export function toSortKeys(sort: GridSort, columns: readonly ColumnMeta[]): SortKey[] {
  const keys: SortKey[] = [];
  for (const { id, desc } of sort) {
    const column = columns.findIndex((c) => c.name === id);
    if (column >= 0) keys.push({ column, descending: desc });
  }
  return keys;
}

/** The filters by column position, dropping those for columns the result lacks. */
export function toResultFilters(
  filters: readonly { id: string; value: ColumnFilter }[],
  columns: readonly ColumnMeta[],
): ResultFilter[] {
  const out: ResultFilter[] = [];
  for (const { id, value } of filters) {
    const column = columns.findIndex((c) => c.name === id);
    if (column >= 0) {
      out.push({ column, operator: value.operator, value: value.value, value2: value.value2 ?? null });
    }
  }
  return out;
}
