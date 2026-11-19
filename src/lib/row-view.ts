import type { ColumnMeta, ResultFilter, SortKey } from "./bindings";
import { type ColumnFilter, isActiveFilter } from "./grid-filter";

/**
 * What every `RowSource` agrees on about a view (a sort and filters), so two
 * sources cannot disagree about which views are the same.
 */

export const sameSort = (a: readonly SortKey[], b: readonly SortKey[]) =>
  a.length === b.length && a.every((k, i) => k.column === b[i].column && k.descending === b[i].descending);

export const sameFilters = (a: readonly ResultFilter[], b: readonly ResultFilter[]) =>
  a.length === b.length
  && a.every((f, i) =>
    f.column === b[i].column && f.operator === b[i].operator && f.value === b[i].value
    && (f.value2 ?? null) === (b[i].value2 ?? null)
  );

export const toColumnFilter = (f: ResultFilter): ColumnFilter => ({
  operator: f.operator,
  value: f.value,
  value2: f.value2 ?? undefined,
});

/**
 * Drop what cannot apply, so two views that show the same rows compare equal.
 * Shared by every source: it is what makes `setView` idempotent.
 */
export function normalizeView(
  columns: readonly ColumnMeta[],
  sort: readonly SortKey[],
  filters: readonly ResultFilter[],
): { sort: SortKey[]; filters: ResultFilter[] } {
  return {
    sort: sort.filter((k) => columns[k.column] !== undefined),
    filters: filters.filter((f) => columns[f.column] !== undefined && isActiveFilter(toColumnFilter(f))),
  };
}
